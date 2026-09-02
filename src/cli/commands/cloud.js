import { spawn } from 'node:child_process';
import os from 'node:os';
import process from 'node:process';
import { createAuditLogger } from '../../audit/logger.js';
import { createRuntime } from '../../core/runtime.js';
import { createPolicyManager } from '../../permissions/manager.js';
import { instancePolicyPath, loadInstancePolicy, resetInstancePolicy } from '../../permissions/store.js';
import { startTui } from '../../tui/index.js';
import { createToolManifest } from '../../transport/mcp/tools/registry.js';
import { defaultToolManifestPath, inspectToolManifest } from '../../transport/mcp/manifest-store.js';
import { createCloudAgent } from '../../transport/cloud.js';
import { isCredentialExpired, loadCredentials } from '../../utils/credentials.js';
import { startInstanceControl } from '../../utils/instance-control.js';
import {
  claimInstanceName,
  createInstanceId,
  loadInstance,
  openInstanceLog,
  releaseInstanceName,
  removeInstanceRecord,
  saveInstance,
  shortInstanceId,
  updateInstance
} from '../../utils/instances.js';
import { getPackageMetadata } from '../../version.js';
import { getOption, hasFlag, resolveRoot } from '../options.js';
import { runLogin } from './login.js';

const POLICY_CATEGORIES = new Set(['read', 'write', 'command', 'dangerous', 'outsideRoot']);
const POLICY_ACTIONS = new Set(['allow', 'ask', 'deny']);
const HANDOFF_TIMEOUT_MS = 8000;

async function ensureCredentials() {
  let credentials = await loadCredentials();
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  if (!credentials) {
    if (!interactive) throw new Error('This device is not signed in. Run `bdxa login` first.');
    console.log('Buildifyx Desktop Agent\n');
    console.log('This computer is not signed in yet.');
    console.log('Sign in once, then bdxa will connect this workspace to Buildifyx Cloud.\n');
    await runLogin([], { showConnectHint: false });
    credentials = await loadCredentials();
  }

  if (credentials && isCredentialExpired(credentials)) {
    if (!interactive) throw new Error('This device sign-in has expired. Run `bdxa login` again.');
    console.log('Your device sign-in has expired.');
    console.log('Enter a new login token to reconnect this computer.\n');
    await runLogin([], { showConnectHint: false });
    credentials = await loadCredentials();
  }

  if (!credentials) throw new Error('Could not load the device credential after sign-in.');
  return credentials;
}

function approvalForDashboard(request) {
  return {
    id: request.id,
    createdAt: request.createdAt,
    toolName: request.toolName,
    description: request.description,
    category: request.category,
    pathInfo: request.pathInfo ? { ...request.pathInfo } : null,
    evaluation: request.evaluation ? { ...request.evaluation } : null
  };
}

function hasInFlightTools(events) {
  const active = new Set();
  for (const event of events) {
    if (!event.requestId) continue;
    if (event.type === 'tool.started') active.add(event.requestId);
    if (event.type === 'tool.completed' || event.type === 'tool.failed') active.delete(event.requestId);
  }
  return active.size > 0;
}

function waitForChildMessage(child, expectedType, instanceId, timeoutMs = HANDOFF_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
      callback();
    };
    const onMessage = (message) => {
      if (message?.type !== expectedType || message?.instanceId !== instanceId) return;
      finish(() => resolve(message));
    };
    const onExit = (code, signal) => finish(() => reject(new Error(`Background handoff child exited before ${expectedType} (${signal ?? code ?? 'unknown'}).`)));
    const onError = (error) => finish(() => reject(error));
    const timer = setTimeout(() => finish(() => reject(new Error(`Timed out waiting for background handoff (${expectedType}).`))), timeoutMs);
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function prepareHandoffChild({ root, name, instanceId, unrestrictedCommands }) {
  const script = process.argv[1];
  if (!script) throw new Error('Could not determine the bdxa CLI entrypoint for background handoff.');
  const { filePath: logPath, handle } = await openInstanceLog(instanceId);
  const childArgs = [
    script,
    '--root', root,
    '--instance-id', instanceId,
    '--instance-name', name,
    '--background-child',
    '--handoff-child'
  ];
  if (unrestrictedCommands) childArgs.push('--unrestricted-commands');

  let child;
  try {
    child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: ['ignore', handle.fd, handle.fd, 'ipc'],
      windowsHide: true,
      env: process.env
    });
    if (!child.pid) throw new Error('Could not start background handoff process.');
    await waitForChildMessage(child, 'handoff.ready', instanceId);
  } catch (error) {
    child?.kill();
    throw error;
  } finally {
    await handle.close();
  }

  return {
    child,
    logPath,
    async activate() {
      const active = waitForChildMessage(child, 'handoff.active', instanceId);
      child.send({ type: 'handoff.activate', instanceId });
      const message = await active;
      child.unref();
      return { pid: message.pid ?? child.pid, logPath };
    },
    cancel() {
      try { child.send({ type: 'handoff.cancel', instanceId }); } catch {}
      try { child.kill(); } catch {}
    }
  };
}

async function waitForHandoffActivation(instanceId) {
  if (typeof process.send !== 'function') throw new Error('Background handoff child requires an IPC channel.');
  process.send({ type: 'handoff.ready', instanceId, pid: process.pid });

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      callback();
    };
    const onMessage = (message) => {
      if (message?.instanceId !== instanceId) return;
      if (message.type === 'handoff.activate') finish(resolve);
      else if (message.type === 'handoff.cancel') finish(() => reject(new Error('Background handoff was cancelled.')));
    };
    const onDisconnect = () => finish(() => reject(new Error('Background handoff parent disconnected before activation.')));
    const timer = setTimeout(() => finish(() => reject(new Error('Timed out waiting for foreground handoff activation.'))), 30_000);
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
  });
}

function notifyHandoffActive(instanceId) {
  if (typeof process.send !== 'function') return;
  try { process.send({ type: 'handoff.active', instanceId, pid: process.pid }); } catch {}
  try { process.disconnect(); } catch {}
}

async function startDetached({ root, name, instanceId, unrestrictedCommands, credentials, metadata }) {
  const script = process.argv[1];
  if (!script) throw new Error('Could not determine the bdxa CLI entrypoint for detached mode.');
  const { filePath: logPath, handle } = await openInstanceLog(instanceId);
  const childArgs = [script, '--root', root, '--instance-id', instanceId, '--instance-name', name, '--background-child'];
  if (unrestrictedCommands) childArgs.push('--unrestricted-commands');

  await saveInstance({
    instanceId,
    name,
    workspace: root,
    mode: 'background',
    pid: 0,
    status: 'starting',
    startedAt: new Date().toISOString(),
    agentVersion: metadata.version,
    deviceName: credentials.deviceName ?? credentials.deviceId,
    logPath
  });

  let child;
  try {
    child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: ['ignore', handle.fd, handle.fd],
      windowsHide: true,
      env: process.env
    });
    if (!child.pid) throw new Error('Could not start detached bdxa process.');
    child.unref();
    await updateInstance(instanceId, { pid: child.pid });
  } catch (error) {
    await removeInstanceRecord(instanceId);
    await releaseInstanceName(name, instanceId).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }

  console.log(`✓ Started ${name}`);
  console.log(`  ID         ${shortInstanceId(instanceId)}`);
  console.log(`  Workspace  ${root}`);
  console.log(`  PID        ${child.pid}`);
  console.log(`  Log        ${logPath}`);
}

export async function runCloud(args, { metadata: suppliedMetadata, updateStatus = null } = {}) {
  const credentials = await ensureCredentials();
  const root = await resolveRoot(getOption(args, '--root', process.cwd()));
  const unrestrictedCommands = hasFlag(args, '--unrestricted-commands') || hasFlag(args, '--full-access');
  const backgroundChild = hasFlag(args, '--background-child');
  const handoffChild = hasFlag(args, '--handoff-child');
  const detach = hasFlag(args, '-d') || hasFlag(args, '--detach');
  const metadata = suppliedMetadata ?? await getPackageMetadata();
  const suppliedInstanceId = getOption(args, '--instance-id', null);
  const suppliedInstanceName = getOption(args, '--instance-name', null);
  const requestedName = suppliedInstanceName ?? getOption(args, '--name', null);
  const instanceId = suppliedInstanceId ?? createInstanceId();
  const name = suppliedInstanceName ?? await claimInstanceName(root, requestedName, instanceId);

  if (detach && !backgroundChild) {
    await startDetached({ root, name, instanceId, unrestrictedCommands, credentials, metadata });
    return;
  }

  if (handoffChild) await waitForHandoffActivation(instanceId);

  const mode = backgroundChild ? 'background' : 'foreground';
  const useTui = mode === 'foreground' && process.stdin.isTTY && process.stdout.isTTY && !hasFlag(args, '--no-tui');
  const previousRecord = backgroundChild ? await loadInstance(instanceId) : null;
  await saveInstance({
    ...(previousRecord ?? {}),
    instanceId,
    name,
    workspace: root,
    mode,
    pid: process.pid,
    status: 'starting',
    startedAt: previousRecord?.startedAt ?? new Date().toISOString(),
    agentVersion: metadata.version,
    deviceName: credentials.deviceName ?? credentials.deviceId
  });

  const policyFilePath = instancePolicyPath(instanceId);
  const policy = await loadInstancePolicy(instanceId);
  const policyManager = createPolicyManager(policy, { filePath: policyFilePath });
  const runtime = createRuntime({
    root,
    fullAccess: unrestrictedCommands,
    policyManager,
    interactive: useTui || mode === 'background'
  });
  const audit = createAuditLogger({
    eventBus: runtime.eventBus,
    context: { instanceId, workspaceName: name, workspacePath: root }
  });
  const manifest = createToolManifest({ fullAccess: unrestrictedCommands });
  const manifestState = await inspectToolManifest(manifest, defaultToolManifestPath(unrestrictedCommands ? 'unrestricted' : 'restricted'));
  const accessMode = unrestrictedCommands ? 'Unrestricted commands · not sandboxed' : 'Restricted commands';
  audit.start();

  const cloud = createCloudAgent({
    cloudUrl: credentials.cloudUrl,
    credentials,
    runtime,
    manifest,
    version: metadata.version,
    instance: { instanceId, name, path: root, mode },
    deviceInfo: {
      name: credentials.deviceName ?? os.hostname(),
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch
    },
    eventBus: runtime.eventBus
  });

  let closing = false;
  let handedOff = false;
  let control = null;
  let unsubscribeCloud = () => {};
  let onSignal = null;
  let registryUpdate = Promise.resolve();

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    unsubscribeCloud();
    audit.stop();
    await registryUpdate.catch(() => undefined);
    await cloud.stop();
    if (control) await control.close().catch(() => undefined);
    control = null;
    if (!handedOff) {
      await removeInstanceRecord(instanceId);
      await releaseInstanceName(name, instanceId).catch(() => undefined);
    }
  };

  const shutdownAndExit = async (code = 0) => {
    await shutdown();
    process.exit(code);
  };

  const dashboardSnapshot = () => ({
    version: metadata.version,
    updateStatus,
    root,
    instanceId,
    instanceName: name,
    runtimeMode: mode,
    accessMode,
    auditPath: audit.filePath,
    toolManifest: manifest,
    toolManifestState: manifestState,
    toolsUrl: credentials.cloudUrl,
    events: runtime.eventBus.getHistory(),
    approvals: (runtime.approvalQueue?.getPending() ?? []).map(approvalForDashboard),
    policy: policyManager.get(),
    connection: cloud.getState()
  });

  const handleControlCommand = async (message) => {
    if (message.command === 'dashboard.snapshot') return { dashboard: dashboardSnapshot() };
    if (message.command === 'approval.list') return { approvals: dashboardSnapshot().approvals };
    if (message.command === 'approval.resolve') {
      const action = message.action === 'allow' ? 'allow' : message.action === 'deny' ? 'deny' : null;
      if (!action || typeof message.requestId !== 'string') throw new Error('Invalid approval decision.');
      const remember = ['command', 'root'].includes(message.remember) ? message.remember : null;
      const resolved = runtime.approvalQueue?.resolve(message.requestId, { action, remember }) ?? false;
      if (!resolved) throw new Error('Approval request is no longer pending.');
      return { resolved: true, requestId: message.requestId };
    }
    if (message.command === 'policy.setCategory') {
      if (!POLICY_CATEGORIES.has(message.category) || !POLICY_ACTIONS.has(message.action)) throw new Error('Invalid permission category or action.');
      return { policy: await policyManager.setCategory(message.category, message.action) };
    }
    if (message.command === 'policy.addRoot') {
      if (typeof message.root !== 'string' || !message.root.trim()) throw new Error('Root path is required.');
      return { policy: await policyManager.addRoot(message.root) };
    }
    if (message.command === 'policy.removeRoot') {
      if (!Number.isInteger(message.index) || message.index < 0) throw new Error('Invalid root index.');
      return { policy: await policyManager.removeRoot(message.index) };
    }
    if (message.command === 'policy.addCommandRule') {
      if (typeof message.executable !== 'string' || !message.executable.trim()) throw new Error('Executable is required.');
      if (!Array.isArray(message.argsPrefix) || !message.argsPrefix.every((value) => typeof value === 'string')) throw new Error('Invalid command arguments.');
      if (!POLICY_ACTIONS.has(message.action)) throw new Error('Invalid command rule action.');
      return {
        policy: await policyManager.addCommandRule({
          executable: message.executable,
          argsPrefix: message.argsPrefix,
          action: message.action
        })
      };
    }
    if (message.command === 'policy.removeCommandRule') {
      if (!Number.isInteger(message.index) || message.index < 0) throw new Error('Invalid command rule index.');
      return { policy: await policyManager.removeCommandRule(message.index) };
    }
    return undefined;
  };

  const startControl = async () => {
    control = await startInstanceControl({
      instanceId,
      metadata: {
        name,
        workspace: root,
        mode,
        agentVersion: metadata.version,
        deviceName: credentials.deviceName ?? credentials.deviceId,
        startedAt: previousRecord?.startedAt ?? new Date().toISOString(),
        logPath: previousRecord?.logPath ?? null
      },
      onShutdown: () => shutdownAndExit(0),
      onCommand: handleControlCommand
    });
    await updateInstance(instanceId, { controlPath: control.endpoint });
  };
  try {
    await startControl();
  } catch (error) {
    audit.stop();
    if (handoffChild && suppliedInstanceId) {
      await updateInstance(instanceId, { status: 'handoff_failed', lastError: error?.message ?? String(error) }).catch(() => undefined);
    } else {
      await resetInstancePolicy(instanceId).catch(() => undefined);
      await removeInstanceRecord(instanceId);
      await releaseInstanceName(name, instanceId).catch(() => undefined);
    }
    throw error;
  }

  unsubscribeCloud = cloud.subscribe((state) => {
    registryUpdate = registryUpdate
      .then(() => {
        if (closing) return undefined;
        return updateInstance(instanceId, {
          status: state.status,
          ...(state.connectedAt ? { connectedAt: state.connectedAt } : {}),
          lastError: state.lastError ?? null
        });
      })
      .catch(() => undefined);
    if (state.status === 'revoked') void shutdownAndExit(0);
  });

  onSignal = () => { void shutdownAndExit(0); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  cloud.connect();
  if (handoffChild) notifyHandoffActive(instanceId);

  const handoffToBackground = async () => {
    if (mode !== 'foreground') return;
    if (hasInFlightTools(runtime.eventBus.getHistory())) throw new Error('Wait for the active tool request to finish before moving this workspace to the background.');
    const prepared = await prepareHandoffChild({ root, name, instanceId, unrestrictedCommands });
    const parentControlPath = control?.endpoint ?? null;

    try {
      if (control) await control.close();
      control = null;

      const activated = await prepared.activate();
      handedOff = true;
      unsubscribeCloud();
      audit.stop();
      await cloud.stop();
      closing = true;
      if (onSignal) {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      }
      await updateInstance(instanceId, {
        pid: activated.pid,
        mode: 'background',
        logPath: activated.logPath
      });
      return activated;
    } catch (error) {
      prepared.cancel();
      if (!handedOff) {
        try {
          await updateInstance(instanceId, {
            pid: process.pid,
            mode: 'foreground',
            controlPath: parentControlPath,
            status: cloud.getState().status
          });
          await startControl();
        } catch (restoreError) {
          const fatal = new Error(`Background handoff failed and the foreground control channel could not be restored: ${restoreError.message}`);
          fatal.handoffFatal = true;
          throw fatal;
        }
      }
      throw error;
    }
  };

  if (!useTui) {
    console.log('Buildifyx Desktop Agent');
    console.log(`Version v${metadata.version}`);
    console.log('');
    console.log('● Starting');
    console.log(`  Instance   ${name} (${shortInstanceId(instanceId)})`);
    console.log(`  Workspace  ${root}`);
    console.log(`  Device     ${credentials.deviceName ?? credentials.deviceId}`);
    console.log(`  Mode       ${mode}`);
    console.log(`  Commands   ${unrestrictedCommands ? 'Unrestricted executable names (not sandboxed)' : 'Restricted by local command policy'}`);
    if (mode === 'foreground') {
      console.log('\nInteractive approvals are disabled. Requests requiring approval will return CONFIRMATION_REQUIRED.');
    } else {
      console.log(`\nUse \`bdxa attach ${name}\` to open this workspace dashboard.`);
    }
    return;
  }

  const tui = startTui({
    eventBus: runtime.eventBus,
    approvalQueue: runtime.approvalQueue,
    policyManager,
    version: metadata.version,
    updateStatus,
    root,
    instanceId,
    instanceName: name,
    mode: accessMode,
    auditPath: audit.filePath,
    toolManifest: manifest,
    toolManifestState: manifestState,
    toolsUrl: credentials.cloudUrl,
    onBackground: handoffToBackground,
    onQuit: shutdown
  });

  await tui.waitUntilExit();
  if (!handedOff) await shutdown();
}
