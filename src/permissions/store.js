import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { normalizePolicy } from './policy.js';

function buildifyxHome() {
  return path.join(os.homedir(), '.buildifyx');
}

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

async function writePolicy(policy, filePath) {
  const normalized = normalizePolicy(policy);
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
  return normalized;
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
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > 30_000) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for permission policy lock: ${filePath}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export async function savePolicy(policy, filePath = defaultPolicyPath()) {
  return withPolicyLock(filePath, () => writePolicy(policy, filePath));
}

export async function updatePolicy(filePath, updater, fallbackPolicy = undefined) {
  return withPolicyLock(filePath, async () => {
    let current;
    try {
      current = normalizePolicy(JSON.parse(await readFile(filePath, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      current = normalizePolicy(fallbackPolicy);
    }
    const next = normalizePolicy(await updater(current));
    return writePolicy(next, filePath);
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
