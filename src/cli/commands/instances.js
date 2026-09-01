import { rm as removeFile } from 'node:fs/promises';
import process from 'node:process';
import { resetInstancePolicy } from '../../permissions/store.js';
import { runAttachedDashboard } from '../../tui/remote.js';
import { requestInstanceControl } from '../../utils/instance-control.js';
import {
  findInstance,
  listInstances,
  releaseInstanceName,
  removeInstanceRecord,
  shortInstanceId,
  terminateRecoveredProcess
} from '../../utils/instances.js';

function pad(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function displayStatus(instance) {
  if (instance.processOnly) return 'orphan';
  if (!instance.live) return instance.pidAlive ? 'stale' : 'exited';
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

  const rows = instances.map((instance) => ({
    id: shortInstanceId(instance.instanceId),
    name: instance.name,
    workspace: instance.workspace,
    mode: instance.mode,
    status: displayStatus(instance)
  }));
  const widths = {
    id: Math.max(8, ...rows.map((row) => row.id.length)),
    name: Math.max(4, ...rows.map((row) => row.name.length)),
    workspace: Math.min(54, Math.max(9, ...rows.map((row) => row.workspace.length))),
    mode: Math.max(4, ...rows.map((row) => row.mode.length))
  };

  console.log(`${pad('ID', widths.id)}  ${pad('NAME', widths.name)}  ${pad('WORKSPACE', widths.workspace)}  ${pad('MODE', widths.mode)}  STATUS`);
  for (const row of rows) {
    const workspace = row.workspace.length > widths.workspace ? `…${row.workspace.slice(-(widths.workspace - 1))}` : row.workspace;
    console.log(`${pad(row.id, widths.id)}  ${pad(row.name, widths.name)}  ${pad(workspace, widths.workspace)}  ${pad(row.mode, widths.mode)}  ${row.status}`);
  }
}

export async function runInstanceInspect(args) {
  const instance = await findInstance(args[0]);
  console.log('Buildifyx Desktop Agent instance');
  console.log('');
  console.log(`Name       ${instance.name}`);
  console.log(`ID         ${instance.instanceId}`);
  console.log(`Status     ${displayStatus(instance)}`);
  console.log(`Mode       ${instance.mode}`);
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

export async function runInstanceAttach(args) {
  const instance = await findInstance(args[0]);
  if (instance.processOnly) throw new Error(`Instance "${instance.name}" is a recovered legacy orphan. Remove and restart it before attaching.`);
  if (!instance.live) throw new Error(`Instance "${instance.name}" is not running.`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('`bdxa attach` requires an interactive terminal.');
  await runAttachedDashboard(instance);
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

async function cleanupInstance(instance) {
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
