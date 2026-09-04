import { spawn } from 'node:child_process';
import { rm as removeFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resetInstancePolicy } from '../../permissions/store.js';
import { getAutostartInstanceIds, removeInstanceAutostart, setInstanceAutostart } from '../../services/autostart.js';
import { runAttachedDashboard } from '../../tui/remote.js';
import { requestInstanceControl } from '../../utils/instance-control.js';
import {
  claimInstanceName,
  findInstance,
  listInstances,
  openInstanceLog,
  releaseInstanceName,
  removeInstanceRecord,
  saveInstance,
  shortInstanceId,
  terminateRecoveredProcess,
  updateInstance
} from '../../utils/instances.js';

function pad(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function displayStatus(instance) {
  if (instance.processOnly) return 'orphan';
  if (!instance.live) {
    if (instance.status === 'restart_failed') return 'restart_failed';
    if (instance.status === 'stopped') return 'stopped';
    return instance.pidAlive ? 'stale' : 'exited';
  }
  if (instance.status === 'connected') return 'online';
  if (instance.status === 'reconnecting' || instance.status === 'connecting') return instance.status;
  return instance.status ?? 'running';
}
export async function runInstanceList(args = []) {
  const instances = await listInstances();
  const quiet = args.includes('-q') || args.includes('--quiet') || !process.stdout.isTTY;

  if (quiet) {
    for (const instance of instances) console.log(instance.instanceId);
    return;
  }

  if (!instances.length) {
    console.log('No bdxa instances found.');
    console.log('Start one with `bdxa` or `bdxa -d`.');
    return;
  }

  const autostartIds = await getAutostartInstanceIds();
  const rows = instances.map((instance) => ({
    id: shortInstanceId(instance.instanceId),
    name: instance.name,
    workspace: instance.workspace,
    mode: instance.mode,
    autostart: autostartIds.has(instance.instanceId) ? 'yes' : 'no',
    status: displayStatus(instance)
  }));
  const widths = {
    id: Math.max(8, ...rows.map((row) => row.id.length)),
    name: Math.max(4, ...rows.map((row) => row.name.length)),
    workspace: Math.min(54, Math.max(9, ...rows.map((row) => row.workspace.length))),
    mode: Math.max(4, ...rows.map((row) => row.mode.length))
  };

  console.log(`${pad('ID', widths.id)}  ${pad('NAME', widths.name)}  ${pad('WORKSPACE', widths.workspace)}  ${pad('MODE', widths.mode)}  AUTOSTART  STATUS`);
  for (const row of rows) {
    const workspace = row.workspace.length > widths.workspace ? `…${row.workspace.slice(-(widths.workspace - 1))}` : row.workspace;
    console.log(`${pad(row.id, widths.id)}  ${pad(row.name, widths.name)}  ${pad(workspace, widths.workspace)}  ${pad(row.mode, widths.mode)}  ${pad(row.autostart, 9)}  ${row.status}`);
  }
}

export async function runInstanceInspect(args) {
  const instance = await findInstance(args[0]);
  const autostart = (await getAutostartInstanceIds()).has(instance.instanceId);
  console.log('Buildifyx Desktop Agent instance');
  console.log('');
  console.log(`Name       ${instance.name}`);
  console.log(`ID         ${instance.instanceId}`);
  console.log(`Status     ${displayStatus(instance)}`);
  console.log(`Mode       ${instance.mode}`);
  console.log(`Autostart  ${autostart ? 'yes' : 'no'}`);
  console.log(`PID        ${instance.pid}`);
  console.log(`Workspace  ${instance.workspace}`);
  if (instance.deviceName) console.log(`Device     ${instance.deviceName}`);
  if (instance.agentVersion) console.log(`Agent      ${instance.agentVersion}`);
  if (instance.startedAt) console.log(`Started    ${instance.startedAt}`);
  if (instance.connectedAt) console.log(`Connected  ${instance.connectedAt}`);
  if (instance.logPath) console.log(`Log        ${instance.logPath}`);
  if (instance.lastError) console.log(`Error      ${instance.lastError}`);
  if (instance.processOnly) console.log('Warning    Recovered from process identity; local control metadata is unavailable.');
  else if (!instance.live && instance.pidAlive) console.log('Warning    PID exists, but it is not verified as this bdxa instance.');
}

export async function runInstanceAttach(args, { metadata = null, updateStatus = null } = {}) {
  const instance = await findInstance(args[0]);
  if (instance.processOnly) throw new Error(`Instance "${instance.name}" is a recovered legacy orphan. Remove and restart it before attaching.`);
  if (!instance.live) throw new Error(`Instance "${instance.name}" is not running.`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('`bdxa attach` requires an interactive terminal.');
  await runAttachedDashboard(instance, { metadata, updateStatus });
}

async function waitUntilGone(identifier, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const current = await findInstance(identifier);
      if (!current.live) return true;
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    return !(await findInstance(identifier)).live;
  } catch {
    return true;
  }
}


async function waitUntilLive(identifier, expectedPid, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const current = await findInstance(identifier);
      if (current.live && current.verified && (!expectedPid || current.pid === expectedPid)) return current;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Restarted instance "${identifier}" did not become ready in time.`);
}

function restartReadyTimeoutMs() {
  const configured = Number(process.env.BUILDFYX_RESTART_READY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 100 && configured <= 30_000 ? configured : 8000;
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function ensureChildExited(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (await waitForChildExit(child, 300)) return;
  try { child.kill('SIGTERM'); } catch {}
  if (await waitForChildExit(child, 1500)) return;
  try { child.kill('SIGKILL'); } catch {}
  await waitForChildExit(child, 500);
}

function dashboardHasActiveWork(dashboard) {
  if ((dashboard.approvals?.length ?? 0) > 0) return true;
  const active = new Set();
  for (const event of dashboard.events ?? []) {
    if (!event.requestId) continue;
    if (event.type === 'tool.started') active.add(event.requestId);
    if (event.type === 'tool.completed' || event.type === 'tool.failed') active.delete(event.requestId);
  }
  return active.size > 0;
}

async function restartBackgroundInstance(instance) {
  if (instance.processOnly) throw new Error(`Instance "${instance.name}" is a recovered legacy orphan and cannot be restarted safely.`);
  if (instance.mode !== 'background') throw new Error(`Instance "${instance.name}" is foreground. Restart it from its own terminal.`);
  if (!instance.live && instance.pidAlive) {
    throw new Error(`Instance "${instance.name}" has an unverified live PID. Remove it before restarting.`);
  }

  let unrestrictedCommands = Boolean(instance.unrestrictedCommands);
  if (instance.live) {
    const snapshot = await requestInstanceControl(instance, 'dashboard.snapshot', { timeoutMs: 1500 });
    if (!snapshot?.ok || !snapshot.dashboard) throw new Error(`Could not read restart settings from "${instance.name}".`);
    if (dashboardHasActiveWork(snapshot.dashboard)) {
      throw new Error(`Instance "${instance.name}" has an active or pending request. Wait for it to finish before restarting.`);
    }
    unrestrictedCommands = String(snapshot.dashboard.accessMode ?? '').startsWith('Unrestricted');

    const shutdown = await requestInstanceControl(instance, 'shutdown', { timeoutMs: 1500 });
    if (!shutdown?.ok || shutdown.instanceId !== instance.instanceId) {
      throw new Error(`Could not safely stop "${instance.name}" before restart.`);
    }
    if (!(await waitUntilGone(instance.instanceId, 5000))) {
      throw new Error(`Instance "${instance.name}" did not stop before restart.`);
    }
  }

  const script = fileURLToPath(new URL('../../cli.js', import.meta.url));
  let logPath = instance.logPath ?? null;
  let handle = null;
  let child = null;

  const restartRecord = (status, lastError = null, pid = 0) => ({
    instanceId: instance.instanceId,
    name: instance.name,
    workspace: instance.workspace,
    mode: 'background',
    pid,
    status,
    startedAt: instance.startedAt ?? new Date().toISOString(),
    agentVersion: instance.agentVersion ?? null,
    deviceName: instance.deviceName ?? null,
    unrestrictedCommands,
    ...(logPath ? { logPath } : {}),
    ...(lastError ? { lastError } : {})
  });

  const preserveFailure = async (error) => {
    await saveInstance(restartRecord('restart_failed', error?.message ?? String(error), 0)).catch(() => undefined);
    await claimInstanceName(instance.workspace, instance.name, instance.instanceId).catch(() => undefined);
  };

  try {
    await releaseInstanceName(instance.name, instance.instanceId).catch(() => undefined);
    await claimInstanceName(instance.workspace, instance.name, instance.instanceId);
    const opened = await openInstanceLog(instance.instanceId);
    logPath = opened.filePath;
    handle = opened.handle;
    await saveInstance(restartRecord('starting'));
    const childArgs = [
      script,
      '--root', instance.workspace,
      '--instance-id', instance.instanceId,
      '--instance-name', instance.name,
      '--background-child',
      '--restart-child'
    ];
    if (unrestrictedCommands) childArgs.push('--unrestricted-commands');

    child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: ['ignore', handle.fd, handle.fd],
      windowsHide: true,
      env: process.env
    });
    if (!child.pid) throw new Error('Could not start replacement bdxa process.');
    child.unref();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await ensureChildExited(child);
    await preserveFailure(error);
    throw new Error(`Restart failed for "${instance.name}": ${error.message}. The instance record and policy were preserved for inspection and retry.`);
  }

  await handle.close();

  try {
    return await waitUntilLive(instance.instanceId, child.pid, restartReadyTimeoutMs());
  } catch (error) {
    await ensureChildExited(child);
    await preserveFailure(error);
    throw new Error(`${error.message} The instance record and policy were preserved for inspection and retry.`);
  }
}
export async function runInstanceStart(args = []) {
  const identifiers = args.filter((arg) => arg !== '--');
  if (!identifiers.length) throw new Error('Usage: bdxa start <name|id> [name|id ...]');

  const handled = new Set();
  for (const identifier of identifiers) {
    const instance = await findInstance(identifier);
    if (handled.has(instance.instanceId)) continue;
    handled.add(instance.instanceId);
    if (instance.processOnly) throw new Error(`Instance "${instance.name}" is a recovered orphan. Use \`bdxa rm\` to clean it up safely.`);
    if (instance.live) throw new Error(`Instance "${instance.name}" is already running.`);
    if (instance.mode !== 'background') throw new Error(`Instance "${instance.name}" is not a background instance and cannot be started from the CLI.`);
    const next = await restartBackgroundInstance(instance);
    console.log(`✓ Started ${next.name} (${shortInstanceId(next.instanceId)}) · v${next.agentVersion ?? 'unknown'}`);
  }
}

export async function runInstanceRestart(args = []) {
  const restartAll = args.includes('-a') || args.includes('--all');
  let identifiers = args.filter((arg) => !['-a', '--all'].includes(arg));

  if (restartAll) {
    const instances = await listInstances();
    identifiers = instances.filter((item) => item.live).map((item) => item.instanceId);
  }
  if (!identifiers.length) {
    if (restartAll) {
      console.log('No running background instances to restart.');
      return;
    }
    throw new Error('Usage: bdxa restart [--all] <name|id> [name|id ...]');
  }

  const failures = [];
  const handled = new Set();
  let restarted = 0;
  let skipped = 0;
  for (const identifier of identifiers) {
    let instance;
    try {
      instance = await findInstance(identifier);
      if (handled.has(instance.instanceId)) continue;
      handled.add(instance.instanceId);
      if (restartAll && instance.mode !== 'background') {
        console.log(`↷ Skipped ${instance.name} (foreground)`);
        skipped += 1;
        continue;
      }
      const next = await restartBackgroundInstance(instance);
      console.log(`✓ Restarted ${next.name} (${shortInstanceId(next.instanceId)}) · v${next.agentVersion ?? 'unknown'}`);
      restarted += 1;
    } catch (error) {
      if (!restartAll) throw error;
      failures.push(`${instance?.name ?? identifier}: ${error.message}`);
    }
  }

  if (restartAll && restarted === 0 && skipped === 0 && failures.length === 0) console.log('No running background instances to restart.');
  if (failures.length) throw new Error(`Some instances could not be restarted: ${failures.join('; ')}`);
}

async function cleanupInstance(instance) {
  await removeInstanceAutostart(instance.instanceId);
  await resetInstancePolicy(instance.instanceId);
  await removeInstanceRecord(instance.instanceId);
  await releaseInstanceName(instance.name, instance.instanceId).catch(() => undefined);
  if (instance.logPath) await removeFile(instance.logPath, { force: true }).catch(() => undefined);
}

export async function runInstanceRemove(args) {
  const force = args.includes('-f') || args.includes('--force');
  const removeAll = args.includes('-a') || args.includes('--all');
  let identifiers = args.filter((arg) => !['-f', '--force', '-a', '--all'].includes(arg));

  if (removeAll) {
    const instances = await listInstances();
    identifiers = [...new Set([...identifiers, ...instances.map((item) => item.instanceId)])];
    if (!identifiers.length) {
      console.log('No bdxa instances to remove.');
      return;
    }
  }

  if (!identifiers.length) throw new Error('Usage: bdxa rm [-f] [--all] <name|id> [name|id ...]');

  for (const identifier of identifiers) {
    const instance = await findInstance(identifier);

    if (instance.processOnly) {
      try {
        await terminateRecoveredProcess(instance, { force });
      } catch (error) {
        throw new Error(`Could not safely stop recovered orphan "${instance.name}": ${error.message}`);
      }
      if (!(await waitUntilGone(instance.instanceId, force ? 1500 : 4000))) {
        throw new Error(`Recovered orphan "${instance.name}" did not stop after its process identity was verified.`);
      }
      await cleanupInstance(instance);
      console.log(`✓ Removed recovered orphan ${instance.name}`);
      continue;
    }

    if (!instance.live) {
      await cleanupInstance(instance);
      console.log(`✓ Removed stale instance ${instance.name}`);
      continue;
    }

    const command = force ? 'force' : 'shutdown';
    try {
      const response = await requestInstanceControl(instance, command, { timeoutMs: 1000 });
      if (!response?.ok || response.instanceId !== instance.instanceId) throw new Error('Instance identity check failed.');
    } catch (error) {
      throw new Error(`Could not safely stop "${instance.name}" because its local control channel could not be verified: ${error.message}`);
    }

    if (!(await waitUntilGone(instance.instanceId, force ? 1500 : 4000))) {
      throw new Error(`Instance "${instance.name}" did not stop. Refusing to signal PID ${instance.pid} because process identity can no longer be verified safely.`);
    }

    await cleanupInstance(instance);
    console.log(`✓ Removed ${instance.name}`);
  }
}

export async function runInstanceStop(args = []) {
  const stopAll = args.includes('-a') || args.includes('--all');
  let identifiers = args.filter((arg) => !['-a', '--all'].includes(arg));

  if (stopAll) {
    const instances = await listInstances();
    identifiers = instances.filter((item) => item.live && item.mode === 'background' && !item.processOnly).map((item) => item.instanceId);
    if (!identifiers.length) {
      console.log('No running background instances to stop.');
      return;
    }
  }

  if (!identifiers.length) throw new Error('Usage: bdxa stop [--all] <name|id> [name|id ...]');

  for (const identifier of identifiers) {
    const instance = await findInstance(identifier);
    if (instance.processOnly) throw new Error(`Instance "${instance.name}" is a recovered orphan. Use \`bdxa rm\` to clean it up safely.`);
    if (instance.mode !== 'background') throw new Error(`Instance "${instance.name}" is foreground. Stop it from its own terminal.`);

    if (!instance.live) {
      if (instance.pidAlive) {
        throw new Error(`Instance "${instance.name}" has an unverified live PID. Use \`bdxa rm\` to clean it up safely.`);
      }
      if (instance.status !== 'stopped') {
        await updateInstance(instance.instanceId, { pid: 0, status: 'stopped', controlPath: null, lastError: null });
      }
      console.log(`✓ Stopped ${instance.name}`);
      continue;
    }

    const response = await requestInstanceControl(instance, 'shutdown', { timeoutMs: 1500 });
    if (!response?.ok || response.instanceId !== instance.instanceId) {
      throw new Error(`Could not safely stop "${instance.name}" because its local control identity check failed.`);
    }
    if (!(await waitUntilGone(instance.instanceId, 5000))) {
      throw new Error(`Instance "${instance.name}" did not stop in time.`);
    }

    const {
      pidAlive: _pidAlive,
      verified: _verified,
      live: _live,
      processOnly: _processOnly,
      processCommand: _processCommand,
      processCwd: _processCwd,
      ...record
    } = instance;

    // Older running agents remove their registry record on shutdown. Re-create
    // the stopped record from the controller so `stop` is backward-compatible.
    await releaseInstanceName(instance.name, instance.instanceId).catch(() => undefined);
    await claimInstanceName(instance.workspace, instance.name, instance.instanceId);
    await saveInstance({
      ...record,
      pid: 0,
      status: 'stopped',
      controlPath: null,
      lastError: null
    });
    console.log(`✓ Stopped ${instance.name}`);
  }
}

export async function runInstanceAutostart(args = []) {
  const disable = args[0] === 'off' || args[0] === 'disable';
  const identifier = disable ? args[1] : args[0];
  if (!identifier || args.length > (disable ? 2 : 1)) {
    throw new Error('Usage: bdxa autostart <name|id> | bdxa autostart off <name|id>');
  }

  const instance = await findInstance(identifier);
  if (instance.processOnly) throw new Error(`Instance "${instance.name}" is a recovered orphan and cannot use autostart.`);
  if (!disable && !instance.live && instance.pidAlive) {
    throw new Error(`Instance "${instance.name}" has an unverified live PID. Refusing to enable autostart.`);
  }
  if (!disable && instance.mode !== 'background') {
    throw new Error(`Instance "${instance.name}" is foreground. Move it to background before enabling autostart.`);
  }

  let unrestrictedCommands = Boolean(instance.unrestrictedCommands);
  if (!disable && instance.live) {
    try {
      const snapshot = await requestInstanceControl(instance, 'dashboard.snapshot', { timeoutMs: 1500 });
      unrestrictedCommands = String(snapshot?.dashboard?.accessMode ?? '').startsWith('Unrestricted');
      await updateInstance(instance.instanceId, { unrestrictedCommands });
    } catch {}
  }

  const enabled = !disable;
  await setInstanceAutostart({
    instanceId: instance.instanceId,
    name: instance.name,
    workspace: instance.workspace,
    unrestrictedCommands
  }, enabled, { cliEntry: process.argv[1] });

  console.log(enabled
    ? `✓ Autostart enabled for ${instance.name}`
    : `✓ Autostart disabled for ${instance.name}`);
}