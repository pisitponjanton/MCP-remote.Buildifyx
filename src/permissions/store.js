import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildifyxHome } from '../utils/home.js';
import { normalizePolicy } from './policy.js';

export function defaultPolicyPath(baseDirectory = buildifyxHome()) {
  return path.join(baseDirectory, 'policy.json');
}

export function workspacePolicyPath(root, baseDirectory = buildifyxHome()) {
  const normalizedRoot = path.resolve(root);
  const workspaceId = createHash('sha256').update(normalizedRoot).digest('hex').slice(0, 16);
  return path.join(baseDirectory, 'workspaces', workspaceId, 'policy.json');
}

export function instancePolicyPath(instanceId, baseDirectory = buildifyxHome()) {
  const settingsId = createHash('sha256').update(String(instanceId ?? '')).digest('hex').slice(0, 24);
  return path.join(baseDirectory, 'instance-settings', settingsId, 'policy.json');
}

export async function loadPolicy(filePath = defaultPolicyPath()) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return normalizePolicy(JSON.parse(raw));
  } catch (error) {
    if (error?.code === 'ENOENT') return normalizePolicy();
    throw error;
  }
}

async function writePolicy(policy, filePath, assertCurrent = () => {}) {
  const normalized = normalizePolicy(policy);
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    // Check right before the atomic commit. Reconnect invalidates old sockets;
    // a stale management request must not publish a new policy file.
    assertCurrent();
    await rename(temporary, filePath);
    return normalized;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Claims and remote permission commits share the instance policy file lock.
 * Ownership cannot change between verification and atomic policy rename.
 */
function generationPath(filePath) { return `${filePath}.remote-generation`; }
async function assertGeneration(filePath, generation) {
  if (typeof generation !== 'string' || !/^[0-9a-f-]{36}$/.test(generation)) {
    throw Object.assign(new Error('Missing remote management generation.'), { code: 'MANAGEMENT_SESSION_STALE' });
  }
  let active;
  try { active = (await readFile(generationPath(filePath), 'utf8')).trim(); }
  catch { throw Object.assign(new Error('Remote management generation unavailable.'), { code: 'MANAGEMENT_SESSION_STALE' }); }
  if (active !== generation) throw Object.assign(new Error('Remote management belongs to a superseded Agent process.'), { code: 'MANAGEMENT_SESSION_STALE' });
}
export async function claimPolicyRemoteGeneration(filePath, generation, assertCurrent = () => {}) {
  return withPolicyLock(filePath, async () => {
    assertCurrent();
    if (typeof generation !== 'string' || !/^[0-9a-f-]{36}$/.test(generation)) {
      throw Object.assign(new Error('Invalid generation token.'), { code: 'MANAGEMENT_SESSION_STALE' });
    }
    await writeFile(generationPath(filePath), generation + '\n', { mode: 0o600 });
    assertCurrent();
    return loadPolicy(filePath);
  });
}

/**
 * Explicit orphan recovery only: never evict from the normal acquire path.
 * An ambiguous PID/ownership state fails closed; callers must opt in.
 */
export async function recoverOrphanedPolicyLock(filePath) {
  const lockPath = `${filePath}.lock`;
  let initial;
  try { initial = await stat(lockPath); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (Date.now() - initial.mtimeMs < 30_000) return false;
  let record;
  try { record = JSON.parse(await readFile(lockPath,'utf8')); }
  catch { return false; }
  if (!Number.isSafeInteger(record?.pid) || record.pid <= 0 || record.pid === process.pid) return false;
  try { process.kill(record.pid,0); return false; }
  catch(error) { if (error?.code !== 'ESRCH') return false; }
  // Verify the same inode/file contents immediately before unlink; if another
  // contender changed ownership, no recovery is permitted.
  const current = await stat(lockPath).catch(()=>null);
  if (!current || current.ino !== initial.ino || current.dev !== initial.dev || current.mtimeMs !== initial.mtimeMs) return false;
  const reread = await readFile(lockPath,'utf8').catch(()=>null);
  if (!reread || reread !== JSON.stringify(record)+'\n') return false;
  await rm(lockPath);
  return true;
}

async function withPolicyLock(filePath, callback) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + 5000;

  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, 'utf8');
        return await callback();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      // Never steal a lock solely because its mtime is old: the holder may
      // still be alive, paused, or doing a slow file commit. Fail closed here.
      // Recovery of an orphaned lock requires a separately verified owner check.
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for permission policy lock: ${filePath}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export async function savePolicy(policy, filePath = defaultPolicyPath()) {
  return withPolicyLock(filePath, () => writePolicy(policy, filePath));
}

export async function updatePolicy(filePath, updater, fallbackPolicy = undefined, { assertCurrent = () => {}, remoteGeneration } = {}) {
  return withPolicyLock(filePath, async () => {
    assertCurrent();
    if (remoteGeneration !== undefined) await assertGeneration(filePath, remoteGeneration);
    let current;
    try {
      current = normalizePolicy(JSON.parse(await readFile(filePath, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      current = normalizePolicy(fallbackPolicy);
    }
    const next = normalizePolicy(await updater(current));
    assertCurrent();
    if (remoteGeneration !== undefined) await assertGeneration(filePath, remoteGeneration);
    // The lock remains held until the atomic rename is complete.
    return writePolicy(next, filePath, assertCurrent);
  });
}

export async function loadWorkspacePolicy(root, baseDirectory = buildifyxHome()) {
  const filePath = workspacePolicyPath(root, baseDirectory);
  try {
    await access(filePath);
    return loadPolicy(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const inherited = await loadPolicy(defaultPolicyPath(baseDirectory));
    try {
      return await savePolicy(inherited, filePath);
    } catch {
      return loadPolicy(filePath);
    }
  }
}

export async function loadInstancePolicy(instanceId, baseDirectory = buildifyxHome()) {
  const filePath = instancePolicyPath(instanceId, baseDirectory);
  try {
    await access(filePath);
    return loadPolicy(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  // Instance policy is lifecycle-scoped. A brand-new instance always starts
  // from DEFAULT_POLICY and never inherits workspace/name policy from another
  // instance, even when both instances point at the same workspace root.
  try {
    return await savePolicy(normalizePolicy(), filePath);
  } catch {
    return loadPolicy(filePath);
  }
}

export async function resetInstancePolicy(instanceId, baseDirectory = buildifyxHome()) {
  const filePath = instancePolicyPath(instanceId, baseDirectory);
  await rm(path.dirname(filePath), { recursive: true, force: true });
  return normalizePolicy();
}
