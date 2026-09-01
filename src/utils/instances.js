import { execFile } from 'node:child_process';
import { mkdir, open, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  identifyInstanceControl,
  instanceControlPath,
  probeInstanceControl,
  requestInstanceControl
} from './instance-control.js';

export const DEFAULT_INSTANCES_DIR = path.join(os.homedir(), '.buildifyx', 'instances');
const MANAGEMENT_COMMANDS = new Set(['login', 'logout', 'status', 'ls', 'ps', 'inspect', 'attach', 'rm', 'doctor', 'd', 'update', 'u', 'help', '-h', '--help', '-v', '--version', 'local', 'remote', 'r']);

function isDefaultInstancesDirectory(directory) {
  return path.resolve(directory) === path.resolve(DEFAULT_INSTANCES_DIR);
}

export function createInstanceId() {
  return `inst_${randomUUID()}`;
}

export function shortInstanceId(instanceId) {
  return instanceId.replace(/^inst_/, '').slice(0, 8);
}

export function instanceFile(instanceId, directory = DEFAULT_INSTANCES_DIR) {
  return path.join(directory, `${instanceId}.json`);
}

export function instanceLogFile(instanceId, directory = DEFAULT_INSTANCES_DIR) {
  return path.join(directory, `${instanceId}.log`);
}

function nameLockFile(name, directory = DEFAULT_INSTANCES_DIR) {
  const key = createHash('sha256').update(String(name).toLowerCase()).digest('hex').slice(0, 24);
  return path.join(directory, `name-${key}.lock`);
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function saveInstance(record, directory = DEFAULT_INSTANCES_DIR) {
  await mkdir(directory, { recursive: true });
  const filePath = instanceFile(record.instanceId, directory);
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
  return record;
}

export async function loadInstance(instanceId, directory = DEFAULT_INSTANCES_DIR) {
  try {
    return JSON.parse(await readFile(instanceFile(instanceId, directory), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function updateInstance(instanceId, patch, directory = DEFAULT_INSTANCES_DIR) {
  const current = await loadInstance(instanceId, directory);
  if (!current) return null;
  return saveInstance({ ...current, ...patch, instanceId }, directory);
}

export async function removeInstanceRecord(instanceId, directory = DEFAULT_INSTANCES_DIR) {
  await rm(instanceFile(instanceId, directory), { force: true });
}

function isStartingGrace(record) {
  if (record.status !== 'starting' || !isProcessAlive(record.pid)) return false;
  const started = Date.parse(record.startedAt ?? '');
  return Number.isFinite(started) && Date.now() - started < 10_000;
}

async function describeLiveness(record) {
  const pidAlive = isProcessAlive(record.pid);
  const verified = pidAlive ? await probeInstanceControl(record, { timeoutMs: 250 }) : false;
  const starting = !verified && isStartingGrace(record);
  return {
    ...record,
    pidAlive,
    verified,
    live: verified || starting,
    status: verified || starting ? (record.status ?? 'running') : 'exited'
  };
}

async function readInstanceRecords(directory) {
  await mkdir(directory, { recursive: true });
  const names = await readdir(directory);
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try { records.push(JSON.parse(await readFile(path.join(directory, name), 'utf8'))); } catch {}
  }
  return { names, records };
}

function mergeCandidate(candidates, instanceId, patch = {}) {
  if (!instanceId) return;
  candidates.set(instanceId, { ...(candidates.get(instanceId) ?? { instanceId }), ...patch, instanceId });
}

async function addRecentAuditCandidates(directory, candidates, knownInstanceIds) {
  if (path.basename(directory) !== 'instances') return;
  const auditPath = path.join(path.dirname(directory), 'audit.log');
  let handle;
  try {
    handle = await open(auditPath, 'r');
    const info = await handle.stat();
    const length = Math.min(info.size, 1024 * 1024);
    if (length <= 0) return;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const lines = buffer.toString('utf8').split('\n').reverse();
    let added = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const instance = JSON.parse(line)?.instance;
        const instanceId = instance?.instanceId;
        if (typeof instanceId !== 'string' || knownInstanceIds.has(instanceId)) continue;
        if (!candidates.has(instanceId)) added += 1;
        mergeCandidate(candidates, instanceId, {
          name: instance.workspaceName,
          workspace: instance.workspacePath,
          controlPath: instanceControlPath(instanceId, directory)
        });
        if (added >= 100) break;
      } catch {}
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function execText(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 1500, ...options }, (error, stdout) => resolve(error ? '' : stdout));
  });
}

function readProcessTable() {
  if (process.platform === 'win32') return Promise.resolve('');
  return execText('ps', ['-axo', 'pid=,args=']);
}

function optionValue(args, option) {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = args.match(new RegExp(`(?:^|\\s)${escaped}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|(\\S+))`));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

export function parseBdxaAgentProcessCommand(command) {
  const marker = command.match(/(?:^|\s)(?:\S*\/)?src\/cli\.js(?:\s|$)/);
  if (!marker || marker.index === undefined) return null;
  const tail = command.slice(marker.index + marker[0].length).trim();
  const first = tail.split(/\s+/)[0] || '';
  if (MANAGEMENT_COMMANDS.has(first)) return null;
  return {
    instanceId: optionValue(command, '--instance-id'),
    name: optionValue(command, '--instance-name') ?? optionValue(command, '--name'),
    root: optionValue(command, '--root'),
    mode: command.includes('--background-child') || command.includes(' -d ') || command.endsWith(' -d') || command.includes(' --detach') ? 'background' : 'foreground'
  };
}

async function processCwd(pid) {
  if (process.platform === 'linux') {
    try { return await readlink(`/proc/${pid}/cwd`); } catch { return null; }
  }
  if (process.platform === 'darwin') {
    const output = await execText('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const line = output.split('\n').find((value) => value.startsWith('n'));
    return line ? line.slice(1) : null;
  }
  return null;
}

async function discoverAgentProcesses() {
  const output = await readProcessTable();
  const found = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    const command = match[2];
    const parsed = parseBdxaAgentProcessCommand(command);
    if (!parsed) continue;
    const cwd = await processCwd(pid);
    const workspace = parsed.root ? path.resolve(cwd ?? process.cwd(), parsed.root) : cwd;
    if (!workspace) continue;
    found.push({
      pid,
      command,
      cwd,
      workspace,
      name: parsed.name ?? path.basename(workspace) ?? 'workspace',
      instanceId: parsed.instanceId,
      mode: parsed.mode
    });
  }
  return found;
}

async function addProcessControlCandidates(directory, candidates, knownInstanceIds, processes) {
  for (const item of processes) {
    if (!item.instanceId || knownInstanceIds.has(item.instanceId)) continue;
    mergeCandidate(candidates, item.instanceId, {
      pid: item.pid,
      name: item.name,
      workspace: item.workspace,
      mode: item.mode,
      controlPath: instanceControlPath(item.instanceId, directory)
    });
  }
}

export async function recoverOrphanInstances(directory = DEFAULT_INSTANCES_DIR, knownInstanceIds = new Set(), processes = []) {
  await mkdir(directory, { recursive: true });
  const names = await readdir(directory);
  const candidates = new Map();

  for (const name of names) {
    if (!name.startsWith('name-') || !name.endsWith('.lock')) continue;
    try {
      const lock = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      if (knownInstanceIds.has(lock.instanceId)) continue;
      mergeCandidate(candidates, lock.instanceId, { name: lock.name, startedAt: lock.claimedAt, controlPath: instanceControlPath(lock.instanceId, directory) });
    } catch {}
  }

  for (const name of names) {
    const match = name.match(/^(inst_[A-Za-z0-9_-]+)\.log$/);
    if (!match || knownInstanceIds.has(match[1])) continue;
    mergeCandidate(candidates, match[1], { logPath: path.join(directory, name), controlPath: instanceControlPath(match[1], directory) });
  }

  if (process.platform !== 'win32') {
    for (const name of names) {
      if (!name.startsWith('ctl-') || !name.endsWith('.sock')) continue;
      const endpoint = path.join(directory, name);
      try {
        const identity = await identifyInstanceControl(endpoint, { timeoutMs: 250 });
        if (!identity?.ok || !identity.instanceId || knownInstanceIds.has(identity.instanceId)) continue;
        mergeCandidate(candidates, identity.instanceId, {
          name: identity.name,
          workspace: identity.workspace,
          mode: identity.mode,
          agentVersion: identity.agentVersion,
          deviceName: identity.deviceName,
          logPath: identity.logPath,
          startedAt: identity.startedAt,
          controlPath: endpoint,
          pid: identity.pid
        });
      } catch {}
    }
  }

  await addRecentAuditCandidates(directory, candidates, knownInstanceIds);
  await addProcessControlCandidates(directory, candidates, knownInstanceIds, processes);

  const recovered = [];
  for (const candidate of candidates.values()) {
    if (knownInstanceIds.has(candidate.instanceId)) continue;
    const controlPath = candidate.controlPath ?? instanceControlPath(candidate.instanceId, directory);
    try {
      const ping = await requestInstanceControl({ instanceId: candidate.instanceId, controlPath }, 'ping', { timeoutMs: 300 });
      if (!ping?.ok || ping.instanceId !== candidate.instanceId || !Number.isInteger(ping.pid)) continue;
      if (candidate.pid && ping.pid !== candidate.pid) continue;

      let dashboard = null;
      try { dashboard = (await requestInstanceControl({ instanceId: candidate.instanceId, controlPath }, 'dashboard.snapshot', { timeoutMs: 500 }))?.dashboard ?? null; } catch {}
      const instanceName = candidate.name ?? dashboard?.instanceName;
      const workspace = candidate.workspace ?? dashboard?.root;
      if (typeof instanceName !== 'string' || !instanceName || typeof workspace !== 'string' || !workspace) continue;

      const record = {
        instanceId: candidate.instanceId,
        name: instanceName,
        workspace,
        mode: candidate.mode ?? dashboard?.runtimeMode ?? 'background',
        pid: ping.pid,
        status: dashboard?.connection?.status ?? 'running',
        startedAt: candidate.startedAt ?? new Date().toISOString(),
        agentVersion: candidate.agentVersion ?? dashboard?.version ?? null,
        deviceName: candidate.deviceName ?? null,
        ...(candidate.logPath ? { logPath: candidate.logPath } : {}),
        controlPath
      };
      if (await loadInstance(candidate.instanceId, directory)) continue;
      await saveInstance(record, directory);
      knownInstanceIds.add(candidate.instanceId);
      recovered.push(record);
    } catch {}
  }
  return recovered;
}

function processOnlyRecord(item) {
  return {
    instanceId: item.instanceId ?? `orphan_pid_${item.pid}`,
    name: item.name,
    workspace: item.workspace,
    mode: item.mode,
    pid: item.pid,
    status: 'orphan',
    startedAt: null,
    agentVersion: null,
    deviceName: null,
    pidAlive: true,
    verified: false,
    live: true,
    processOnly: true,
    processCommand: item.command,
    processCwd: item.cwd
  };
}

export async function listInstances(directory = DEFAULT_INSTANCES_DIR) {
  const { records } = await readInstanceRecords(directory);
  const processes = isDefaultInstancesDirectory(directory) ? await discoverAgentProcesses() : [];
  const known = new Set(records.map((record) => record.instanceId));
  const recovered = await recoverOrphanInstances(directory, known, processes);
  const all = [...records, ...recovered];
  const described = [];
  for (const record of all) described.push(await describeLiveness(record));

  if (!processes.length) return described.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));

  const byPid = new Map(processes.map((item) => [item.pid, item]));
  const seenPids = new Set();
  const merged = described.map((record) => {
    seenPids.add(record.pid);
    const processItem = byPid.get(record.pid);
    if (record.live || !record.pidAlive || !processItem) return record;
    return { ...record, ...processOnlyRecord(processItem), instanceId: record.instanceId, name: record.name, workspace: record.workspace };
  });
  const indexByInstanceId = new Map();
  for (let index = 0; index < merged.length; index += 1) {
    const instanceId = merged[index].instanceId;
    if (instanceId) indexByInstanceId.set(instanceId, index);
  }

  for (const item of processes) {
    if (seenPids.has(item.pid)) continue;
    const existingIndex = item.instanceId ? indexByInstanceId.get(item.instanceId) : undefined;
    if (existingIndex !== undefined) {
      const existing = merged[existingIndex];
      if (!existing.live) {
        merged[existingIndex] = {
          ...existing,
          ...processOnlyRecord(item),
          instanceId: existing.instanceId,
          name: existing.name ?? item.name,
          workspace: existing.workspace ?? item.workspace
        };
      }
      seenPids.add(item.pid);
      continue;
    }

    const recovered = processOnlyRecord(item);
    merged.push(recovered);
    seenPids.add(item.pid);
    if (recovered.instanceId) indexByInstanceId.set(recovered.instanceId, merged.length - 1);
  }
  return merged.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
}

export async function terminateRecoveredProcess(record, { force = false } = {}) {
  if (!record?.processOnly || !Number.isInteger(record.pid) || record.pid <= 0) throw new Error('Process-only recovery metadata is required.');
  const current = (await discoverAgentProcesses()).find((item) => item.pid === record.pid);
  if (!current || current.command !== record.processCommand || current.cwd !== record.processCwd || current.workspace !== record.workspace) {
    throw new Error('Recovered bdxa process identity changed; refusing to signal the PID.');
  }
  process.kill(record.pid, force ? 'SIGKILL' : 'SIGTERM');
  return true;
}

async function lockIsActive(lockPath, directory) {
  try {
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const claimedAt = Date.parse(lock.claimedAt ?? '');
    if (Number.isFinite(claimedAt) && Date.now() - claimedAt < 10_000) return true;
    const record = lock.instanceId ? await loadInstance(lock.instanceId, directory) : null;
    if (record) {
      const state = await describeLiveness(record);
      if (state.live) return true;
    }
    if (lock.instanceId) {
      try {
        const response = await requestInstanceControl({ instanceId: lock.instanceId, controlPath: instanceControlPath(lock.instanceId, directory) }, 'ping', { timeoutMs: 250 });
        if (response?.ok && response.instanceId === lock.instanceId) return true;
      } catch {}
    }
    return false;
  } catch {
    try {
      const info = await stat(lockPath);
      return Date.now() - info.mtimeMs < 10_000;
    } catch {
      return false;
    }
  }
}

async function tryClaimName(name, instanceId, directory) {
  await mkdir(directory, { recursive: true });
  const lockPath = nameLockFile(name, directory);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ instanceId, name, claimedAt: new Date().toISOString() })}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (await lockIsActive(lockPath, directory)) return false;
      await rm(lockPath, { force: true });
    }
  }
  return false;
}

export async function claimInstanceName(root, requestedName, instanceId, directory = DEFAULT_INSTANCES_DIR) {
  const base = (requestedName?.trim() || path.basename(root) || 'workspace').slice(0, 128);
  if (requestedName) {
    if (!(await tryClaimName(base, instanceId, directory))) throw new Error(`Instance name "${base}" is already running.`);
    return base;
  }
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = index === 1 ? base : `${base}-${index}`;
    if (await tryClaimName(candidate, instanceId, directory)) return candidate;
  }
  throw new Error(`Could not allocate a unique instance name for ${base}.`);
}

export async function releaseInstanceName(name, instanceId, directory = DEFAULT_INSTANCES_DIR) {
  const lockPath = nameLockFile(name, directory);
  try {
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    if (lock.instanceId === instanceId) await rm(lockPath, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function findInstance(identifier, directory = DEFAULT_INSTANCES_DIR) {
  const records = await listInstances(directory);
  const needle = String(identifier ?? '').trim();
  if (!needle) throw new Error('Instance name or ID is required.');

  const exact = records.filter((item) => item.instanceId === needle || item.name === needle);
  const exactById = new Map(exact.map((item) => [item.instanceId, item]));
  if (exactById.size === 1) return exactById.values().next().value;
  if (exactById.size > 1) throw new Error(`Instance "${needle}" is ambiguous. Use the instance ID.`);

  const prefix = records.filter((item) => item.instanceId.startsWith(needle) || shortInstanceId(item.instanceId).startsWith(needle));
  const prefixById = new Map(prefix.map((item) => [item.instanceId, item]));
  if (prefixById.size === 1) return prefixById.values().next().value;
  if (prefixById.size > 1) throw new Error(`Instance ID prefix "${needle}" is ambiguous.`);
  throw new Error(`Instance "${needle}" was not found.`);
}

export async function openInstanceLog(instanceId) {
  await mkdir(DEFAULT_INSTANCES_DIR, { recursive: true });
  const filePath = instanceLogFile(instanceId);
  const handle = await open(filePath, 'a');
  return { filePath, handle };
}