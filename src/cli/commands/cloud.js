import { rm as removeFile } from 'node:fs/promises';
import os from 'node:os';
import process from 'node:process';
import { createAuditLogger } from '../../audit/logger.js';
import { createRuntime } from '../../core/runtime.js';
import { createPolicyManager } from '../../permissions/manager.js';
import { instancePolicyPath, loadInstancePolicy, resetInstancePolicy } from '../../permissions/store.js';
import { isInstanceAutostartEnabled, removeInstanceAutostart, setInstanceAutostart } from '../../services/autostart.js';
import { createManagementHandler, MANAGEMENT_ACTIONS } from '../../services/management.js';
import { cloudEnvironment } from '../../runtime/environment.js';
import { approvalForDashboard, hasInFlightTools, notifyHandoffActive, prepareHandoffChild, startDetachedInstance, waitForHandoffActivation } from '../../runtime/instance-process.js';
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

export async function runCloud(args, { metadata: suppliedMetadata, updateStatus = null } = {}) {
  const credentials = await ensureCredentials();
  const environment = cloudEnvironment();
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
    await startDetachedInstance({ environment, root, name, instanceId, unrestrictedCommands, metadata, deviceName: credentials.deviceName ?? credentials.deviceId });
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
    deviceName: credentials.deviceName ?? credentials.deviceId,
    unrestrictedCommands
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

  let cloud = null;
  let requestRemoteRestart = async () => { throw new Error('Remote restart is not ready yet.'); };
  const baseManagementHandler = createManagementHandler({
    policyManager,
    instance: { instanceId, name, path: root, mode },
    getConnectionState: () => cloud?.getState() ?? null,
    onRestart: () => requestRemoteRestart(),
    onStop: () => stopAndExit(),
    onRemove: () => removeAndExit(),
    getAutostart: () => isInstanceAutostartEnabled(instanceId),
    setAutostart: (enabled) => setInstanceAutostart({
      instanceId,
      name,
      workspace: root,
      unrestrictedCommands
    }, enabled, { cliEntry: process.argv[1] })
  });
  const managementHandler = async (action, argumentsValue, context) => {
    if (['instance.restart', 'instance.remove'].includes(action)) {
      if (hasInFlightTools(runtime.eventBus.getHistory()) || (runtime.approvalQueue?.getPending()?.length ?? 0) > 0) {
        throw new Error('Wait for active tools and approvals to finish before changing this instance lifecycle.');
      }
    }
    const result = await baseManagementHandler(action, argumentsValue, context);
    if (!['settings.get', 'instance.status', 'autostart.get'].includes(action)) {
      runtime.eventBus.emit('management.changed', {
        requestId: context?.requestId ?? null,
        action,
        category: typeof argumentsValue?.category === 'string' ? argumentsValue.category : undefined,
        root: typeof argumentsValue?.root === 'string' ? argumentsValue.root : undefined,
        executable: typeof argumentsValue?.executable === 'string' ? argumentsValue.executable : undefined,
        enabled: typeof argumentsValue?.enabled === 'boolean' ? argumentsValue.enabled : undefined
      });
    }
    return result;
  };

  cloud = createCloudAgent({
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
    eventBus: runtime.eventBus,
    managementHandler,
    managementCapabilities: MANAGEMENT_ACTIONS
  });
  let closing = false;
  let handedOff = false;
  let control = null;
  let unsubscribeCloud = () => {};
  let onSignal = null;
  let registryUpdate = Promise.resolve();
  const shutdown = async ({ preserveInstance = false, finalStatus = 'stopped' } = {}) => {
    if (closing) return;
    closing = true;
    unsubscribeCloud();
    const runtimeStopping = runtime.stop?.('Agent is shutting down');
    await registryUpdate.catch(() => undefined);
    await runtimeStopping;
    await cloud.stop();
    audit.stop();
    await audit.flush?.();
    if (control) await control.close().catch(() => undefined);
    control = null;
    if (!handedOff) {
      if (preserveInstance) {
        await updateInstance(instanceId, { pid: 0, status: finalStatus, controlPath: null, lastError: null }).catch(() => undefined);
      } else {
        await removeInstanceRecord(instanceId);
        await releaseInstanceName(name, instanceId).catch(() => undefined);
      }
    }
  };

  const shutdownAndExit = async (code = 0) => {
    await shutdown();
    process.exit(code);
  };

  const stopAndExit = async () => {
    await shutdown({ preserveInstance: true, finalStatus: 'stopped' });
    process.exit(0);
  };

  const removeAndExit = async () => {
    const logPath = previousRecord?.logPath ?? null;
    await removeInstanceAutostart(instanceId);
    await shutdown();
    await resetInstancePolicy(instanceId).catch(() => undefined);
    if (logPath) await removeFile(logPath, { force: true }).catch(() => undefined);
    process.exit(0);
  };
  const forceShutdownAndExit = async () => {
    if (closing) {
      process.exit(1);
      return;
    }
    closing = true;
    unsubscribeCloud();
    const runtimeStopping = runtime.stop?.('Agent was force-stopped', { force: true });
    await registryUpdate.catch(() => undefined);
    await runtimeStopping?.catch(() => undefined);
    audit.stop();
    await audit.flush?.().catch(() => undefined);
    if (control) await control.close().catch(() => undefined);
    control = null;
    if (!handedOff) {
      await removeInstanceRecord(instanceId).catch(() => undefined);
      await releaseInstanceName(name, instanceId).catch(() => undefined);
    }
    process.exit(1);
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
      onShutdown: () => stopAndExit(),
      onForce: () => forceShutdownAndExit(),
      onCommand: handleControlCommand
    });
    await updateInstance(instanceId, { controlPath: control.endpoint });
  };
  try {
    await startControl();
  } catch (error) {
    audit.stop();
    await audit.flush?.().catch(() => undefined);
    if ((handoffChild || restartChild) && suppliedInstanceId) {
      const failureStatus = restartChild ? 'restart_child_failed' : 'handoff_failed';
      await updateInstance(instanceId, { status: failureStatus, lastError: error?.message ?? String(error) }).catch(() => undefined);
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

  requestRemoteRestart = async () => {
    const prepared = await prepareHandoffChild({ environment, root, name, instanceId, unrestrictedCommands });
    const parentControlPath = control?.endpoint ?? null;

    try {
      if (control) await control.close();
      control = null;
      const activated = await prepared.activate();
      handedOff = true;
      closing = true;
      unsubscribeCloud();
      const runtimeStopping = runtime.stop?.('Agent restarted remotely');
      await registryUpdate.catch(() => undefined);
      await runtimeStopping;
      await cloud.stop();
      audit.stop();
      await audit.flush?.();
      if (onSignal) {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      }
      await updateInstance(instanceId, {
        pid: activated.pid,
        mode: 'background',
        logPath: activated.logPath
      });
      process.exit(0);
    } catch (error) {
      if (!handedOff) prepared.cancel();
      if (!handedOff) {
        await updateInstance(instanceId, {
          pid: process.pid,
          mode,
          controlPath: parentControlPath,
          status: cloud.getState().status
        }).catch(() => undefined);
        if (!control) await startControl().catch(() => undefined);
      }
      if (handedOff) process.exit(1);
      throw error;
    }
  };

  cloud.connect();
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
      unsubscribeCloud();
      const runtimeStopping = runtime.stop?.('Agent moved to the background');
      await registryUpdate.catch(() => undefined);
      await runtimeStopping;
      await cloud.stop();
      audit.stop();
      await audit.flush?.();
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
