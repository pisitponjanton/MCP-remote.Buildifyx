import { rm as removeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createAuditLogger } from '../../audit/logger.js';
import { createRuntime } from '../../core/runtime.js';
import { normalizeError } from '../../core/errors.js';
import { createPolicyManager } from '../../permissions/manager.js';
import { instancePolicyPath, loadInstancePolicy, resetInstancePolicy } from '../../permissions/store.js';
import { localEnvironment } from '../../runtime/environment.js';
import { approvalForDashboard, hasInFlightTools, notifyHandoffActive, prepareHandoffChild, startDetachedInstance, waitForHandoffActivation } from '../../runtime/instance-process.js';
import { startTui } from '../../tui/index.js';
import { createLocalGatewayAgent } from '../../transport/local.js';
import { createToolManifest, parseMcpToolInput } from '../../transport/mcp/tools/registry.js';
import { inspectToolManifest } from '../../transport/mcp/manifest-store.js';
import { getLocalGatewayStatus } from '../../local/gateway-control.js';
import { startInstanceControl } from '../../utils/instance-control.js';
import {
  claimInstanceName,
  createInstanceId,
  loadInstance,
  releaseInstanceName,
  removeInstanceRecord,
  saveInstance,
  shortInstanceId,
  updateInstance
} from '../../utils/instances.js';
import { getPackageMetadata } from '../../version.js';
import { getOption, hasFlag, resolveRoot } from '../options.js';

const POLICY_CATEGORIES = new Set(['read', 'write', 'command', 'dangerous', 'outsideRoot']);
const POLICY_ACTIONS = new Set(['allow', 'ask', 'deny']);

export async function runLocalInstance(args, { metadata: suppliedMetadata, updateStatus = null } = {}) {
  const environment = localEnvironment();
  const gatewayStatus = await getLocalGatewayStatus(environment);
  if (!gatewayStatus.running) {
    throw new Error('Local gateway is not running. Start it first with `bdxa local up`.');
  }

  const root = await resolveRoot(getOption(args, '--root', process.cwd()));
  const unrestrictedCommands = hasFlag(args, '--unrestricted-commands') || hasFlag(args, '--full-access');
  const backgroundChild = hasFlag(args, '--background-child');
  const handoffChild = hasFlag(args, '--handoff-child');
  const restartChild = hasFlag(args, '--restart-child');
  const detach = hasFlag(args, '-d') || hasFlag(args, '--detach');
  const metadata = suppliedMetadata ?? await getPackageMetadata();
  const suppliedInstanceId = getOption(args, '--instance-id', null);
  const suppliedInstanceName = getOption(args, '--instance-name', null);
  const requestedName = suppliedInstanceName ?? getOption(args, '--name', null);
  const instanceId = suppliedInstanceId ?? createInstanceId();
  const name = suppliedInstanceName ?? await claimInstanceName(root, requestedName, instanceId, environment.instancesDirectory);

  if (detach && !backgroundChild) {
    await startDetachedInstance({ environment, root, name, instanceId, unrestrictedCommands, metadata, deviceName: os.hostname() });
    return;
  }
  if (handoffChild) await waitForHandoffActivation(instanceId);

  const mode = backgroundChild ? 'background' : 'foreground';
  const useTui = mode === 'foreground' && process.stdin.isTTY && process.stdout.isTTY && !hasFlag(args, '--no-tui');
  const previousRecord = backgroundChild ? await loadInstance(instanceId, environment.instancesDirectory) : null;
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
    deviceName: os.hostname(),
    unrestrictedCommands
  }, environment.instancesDirectory);

  const policyFilePath = instancePolicyPath(instanceId, environment.rootDirectory);
  const policy = await loadInstancePolicy(instanceId, environment.rootDirectory);
  const policyManager = createPolicyManager(policy, { filePath: policyFilePath });
  const runtime = createRuntime({ root, fullAccess: unrestrictedCommands, policyManager, interactive: useTui || mode === 'background' });
  const audit = createAuditLogger({
    eventBus: runtime.eventBus,
    filePath: environment.auditPath,
    context: { instanceId, workspaceName: name, workspacePath: root, transport: 'local' }
  });
  const manifest = createToolManifest({ fullAccess: unrestrictedCommands });
  const manifestFile = path.join(environment.rootDirectory, `tool-manifest${unrestrictedCommands ? '-unrestricted' : '-restricted'}.json`);
  const manifestState = await inspectToolManifest(manifest, manifestFile);
  const accessMode = unrestrictedCommands ? 'Unrestricted commands · not sandboxed' : 'Restricted commands';
  audit.start();

  const connection = createLocalGatewayAgent({ environment, eventBus: runtime.eventBus, instanceId });
  let closing = false;
  let handedOff = false;
  let control = null;
  let unsubscribeConnection = () => {};
  let onSignal = null;
  let registryUpdate = Promise.resolve();

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
    toolsUrl: connection.getState().endpoint ?? `http://127.0.0.1:${gatewayStatus.state.port}/mcp`,
    events: runtime.eventBus.getHistory(),
    approvals: (runtime.approvalQueue?.getPending() ?? []).map(approvalForDashboard),
    policy: policyManager.get(),
    connection: { ...connection.getState(), transport: 'local' }
  });

  const handleControlCommand = async (message) => {
    if (message.command === 'dashboard.snapshot') return { dashboard: dashboardSnapshot() };
    if (message.command === 'approval.list') return { approvals: dashboardSnapshot().approvals };
    if (message.command === 'approval.resolve') {
      const action = message.action === 'allow' ? 'allow' : message.action === 'deny' ? 'deny' : null;
      const approvalId = typeof message.approvalId === 'string'
        ? message.approvalId
        : typeof message.requestId === 'string' ? message.requestId : null;
      if (!action || !approvalId) throw new Error('Invalid approval decision.');
      const remember = ['command', 'root'].includes(message.remember) ? message.remember : null;
      const resolved = runtime.approvalQueue?.resolve(approvalId, { action, remember }) ?? false;
      if (!resolved) throw new Error('Approval request is no longer pending.');
      return { resolved: true, approvalId };
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
      return { policy: await policyManager.addCommandRule({ executable: message.executable, argsPrefix: message.argsPrefix, action: message.action }) };
    }
    if (message.command === 'policy.removeCommandRule') {
      if (!Number.isInteger(message.index) || message.index < 0) throw new Error('Invalid command rule index.');
      return { policy: await policyManager.removeCommandRule(message.index) };
    }
    if (message.command === 'tool.cancel') {
      if (typeof message.requestId !== 'string' || !message.requestId) throw new Error('Tool requestId is required.');
      return { cancelled: runtime.cancel(message.requestId, message.reason ?? 'Local MCP request was cancelled') };
    }
    if (message.command === 'tool.call') {
      if (typeof message.requestId !== 'string' || !message.requestId || typeof message.tool !== 'string' || !message.tool) {
        throw new Error('Invalid local MCP tool request.');
      }
      try {
        const input = parseMcpToolInput(message.tool, message.arguments ?? {});
        const result = await runtime.dispatch(message.tool, input, { requestId: message.requestId });
        return { result };
      } catch (error) {
        const normalized = normalizeError(error);
        const forwarded = new Error(normalized.message);
        forwarded.code = normalized.code;
        forwarded.details = normalized.details;
        throw forwarded;
      }
    }
    return undefined;
  };

  const shutdown = async ({ preserveInstance = false, finalStatus = 'stopped' } = {}) => {
    if (closing) return;
    closing = true;
    unsubscribeConnection();
    const runtimeStopping = runtime.stop?.('Agent is shutting down');
    await registryUpdate.catch(() => undefined);
    await runtimeStopping;
    await connection.stop();
    audit.stop();
    await audit.flush?.();
    if (control) await control.close().catch(() => undefined);
    control = null;
    if (!handedOff) {
      if (preserveInstance) {
        await updateInstance(instanceId, { pid: 0, status: finalStatus, controlPath: null, lastError: null }, environment.instancesDirectory).catch(() => undefined);
      } else {
        await removeInstanceRecord(instanceId, environment.instancesDirectory);
        await releaseInstanceName(name, instanceId, environment.instancesDirectory).catch(() => undefined);
      }
    }
  };

  const shutdownAndExit = async (code = 0) => { await shutdown(); process.exit(code); };
  const stopAndExit = async () => { await shutdown({ preserveInstance: true, finalStatus: 'stopped' }); process.exit(0); };
  const forceShutdownAndExit = async () => {
    if (closing) return process.exit(1);
    closing = true;
    unsubscribeConnection();
    await runtime.stop?.('Agent was force-stopped', { force: true }).catch(() => undefined);
    audit.stop();
    await audit.flush?.().catch(() => undefined);
    if (control) await control.close().catch(() => undefined);
    if (!handedOff) {
      await removeInstanceRecord(instanceId, environment.instancesDirectory).catch(() => undefined);
      await releaseInstanceName(name, instanceId, environment.instancesDirectory).catch(() => undefined);
    }
    process.exit(1);
  };

  const startControl = async () => {
    control = await startInstanceControl({
      instanceId,
      directory: environment.instancesDirectory,
      metadata: {
        name,
        workspace: root,
        mode,
        agentVersion: metadata.version,
        deviceName: os.hostname(),
        startedAt: previousRecord?.startedAt ?? new Date().toISOString(),
        logPath: previousRecord?.logPath ?? null,
        transport: 'local'
      },
      onShutdown: (message) => message?.preserveInstance === false ? shutdownAndExit(0) : stopAndExit(),
      onForce: () => forceShutdownAndExit(),
      onCommand: handleControlCommand
    });
    await updateInstance(instanceId, { controlPath: control.endpoint }, environment.instancesDirectory);
  };

  try {
    await startControl();
  } catch (error) {
    audit.stop();
    await audit.flush?.().catch(() => undefined);
    if ((handoffChild || restartChild) && suppliedInstanceId) {
      const failureStatus = restartChild ? 'restart_child_failed' : 'handoff_failed';
      await updateInstance(instanceId, { status: failureStatus, lastError: error?.message ?? String(error) }, environment.instancesDirectory).catch(() => undefined);
    } else {
      await resetInstancePolicy(instanceId, environment.rootDirectory).catch(() => undefined);
      await removeInstanceRecord(instanceId, environment.instancesDirectory);
      await releaseInstanceName(name, instanceId, environment.instancesDirectory).catch(() => undefined);
    }
    throw error;
  }

  unsubscribeConnection = connection.subscribe((state) => {
    registryUpdate = registryUpdate.then(() => {
      if (closing) return undefined;
      return updateInstance(instanceId, {
        status: state.status,
        ...(state.connectedAt ? { connectedAt: state.connectedAt } : {}),
        lastError: state.lastError ?? null
      }, environment.instancesDirectory);
    }).catch(() => undefined);
  });

  onSignal = () => { void shutdownAndExit(0); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  connection.connect();
  await connection.refresh();
  if (handoffChild) notifyHandoffActive(instanceId);

  const handoffToBackground = async () => {
    if (mode !== 'foreground') return;
    if (hasInFlightTools(runtime.eventBus.getHistory())) throw new Error('Wait for the active tool request to finish before moving this workspace to the background.');
    const prepared = await prepareHandoffChild({ environment, root, name, instanceId, unrestrictedCommands });
    const parentControlPath = control?.endpoint ?? null;
    try {
      if (control) await control.close();
      control = null;
      const activated = await prepared.activate();
      handedOff = true;
      closing = true;
      unsubscribeConnection();
      await runtime.stop?.('Agent moved to the background');
      await registryUpdate.catch(() => undefined);
      await connection.stop();
      audit.stop();
      await audit.flush?.();
      if (onSignal) {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      }
      await updateInstance(instanceId, { pid: activated.pid, mode: 'background', logPath: activated.logPath }, environment.instancesDirectory);
      return activated;
    } catch (error) {
      prepared.cancel();
      if (!handedOff) {
        try {
          await updateInstance(instanceId, { pid: process.pid, mode: 'foreground', controlPath: parentControlPath, status: connection.getState().status }, environment.instancesDirectory);
          await startControl();
        } catch (restoreError) {
          const fatal = new Error(`Local background handoff failed and the foreground control channel could not be restored: ${restoreError.message}`);
          fatal.handoffFatal = true;
          throw fatal;
        }
      }
      throw error;
    }
  };

  if (!useTui) {
    console.log('Buildifyx Desktop Agent · local');
    console.log(`Version v${metadata.version}`);
    console.log('');
    console.log('● Local');
    console.log(`  Instance   ${name} (${shortInstanceId(instanceId)})`);
    console.log(`  Workspace  ${root}`);
    console.log(`  Gateway    http://127.0.0.1:${gatewayStatus.state.port}/mcp`);
    console.log(`  Mode       ${mode}`);
    console.log(`  Commands   ${unrestrictedCommands ? 'Unrestricted executable names (not sandboxed)' : 'Restricted by local command policy'}`);
    if (mode === 'foreground') console.log('\nInteractive approvals are disabled. Requests requiring approval will return CONFIRMATION_REQUIRED.');
    else console.log(`\nUse \`bdxa local attach ${name}\` to open this workspace dashboard.`);
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
    mode: `Local · ${accessMode}`,
    auditPath: audit.filePath,
    toolManifest: manifest,
    toolManifestState: manifestState,
    toolsUrl: `http://127.0.0.1:${gatewayStatus.state.port}/mcp`,
    onBackground: handoffToBackground,
    onQuit: shutdown
  });

  await tui.waitUntilExit();
  if (!handedOff) await shutdown();
}
