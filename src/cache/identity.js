import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { buildifyxHome } from '../utils/home.js';

export const CACHE_SCHEMA_VERSION = 1;
export const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CACHE_QUOTA_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
export const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const OWNER_KEY_PATTERN = /^owner_[0-9a-f]{64}$/;

export async function assertExistingPrivateDirectory(directory) {
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Unsafe cache directory.');
  // Opening a directory handle is not portable to Node.js on Windows.
  if (process.platform === 'win32') return;
  const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(directory, flags);
  try {
    const actual = await handle.stat();
    if (!actual.isDirectory() || actual.dev !== before.dev || actual.ino !== before.ino) throw new Error('Unsafe cache directory.');
    await handle.chmod(0o700);
  } finally { await handle.close(); }
}

export async function ensurePrivateDirectory(directory) {
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  await assertExistingPrivateDirectory(directory);
}

export async function ensureCacheDirectories(homeDirectory) {
  // A custom home is an explicit trusted configuration, never a client-supplied tool argument.
  await mkdir(homeDirectory, { recursive: true, mode: 0o700 });
  const homeInfo = await lstat(homeDirectory);
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) throw new Error('Buildifyx home must be a real directory.');
  const cacheDirectory = path.join(homeDirectory, 'cache');
  const versionDirectory = path.join(cacheDirectory, 'v1');
  const ownersDirectory = path.join(versionDirectory, 'owners');
  await ensurePrivateDirectory(cacheDirectory);
  await ensurePrivateDirectory(versionDirectory);
  await ensurePrivateDirectory(ownersDirectory);
  return { cacheDirectory, versionDirectory, ownersDirectory };
}

function parseInstallationId(value) {
  let record;
  try { record = JSON.parse(value); } catch { throw new Error('Invalid cache installation identity.'); }
  if (record?.schemaVersion !== 1 || !/^dev_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(record?.deviceInstallId ?? '')) {
    throw new Error('Invalid cache installation identity.');
  }
  return record.deviceInstallId;
}

export async function loadDeviceInstallId(cacheDirectory) {
  const filePath = path.join(cacheDirectory, 'device-install.json');
  const createdId = `dev_${randomUUID()}`;
  try {
    const handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, deviceInstallId: createdId }) + '\n', 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unsafe cache device identity.');
    const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      return parseInstallationId(await handle.readFile('utf8'));
    } catch (error) {
      // A concurrent first-time initializer may still be writing its exclusive file.
      if (attempt === 29) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally { await handle.close(); }
  }
}

export async function resolveCacheOwner({ workspaceRoot, namespace = 'cloud', principalId = null, homeDirectory = buildifyxHome() }) {
  if (!['cloud', 'local'].includes(namespace)) throw new TypeError('Invalid cache namespace.');
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) throw new TypeError('workspaceRoot is required.');
  const canonical = await realpath(path.resolve(workspaceRoot));
  const { cacheDirectory, ownersDirectory, versionDirectory } = await ensureCacheDirectories(homeDirectory);
  const deviceInstallId = await loadDeviceInstallId(cacheDirectory);
  const identityPath = process.platform === 'win32' ? path.normalize(canonical).toLowerCase() : path.normalize(canonical);
  if (principalId !== null && (typeof principalId !== 'string' || !principalId.trim() || principalId.length > 512)) {
    throw new TypeError('Invalid artifact cache principal.');
  }
  // Do not migrate the pre-v0.4 unscoped owner: it has no trustworthy
  // account provenance. New authenticated owners never read or delete it.
  const parts = principalId === null
    ? [deviceInstallId, namespace, identityPath]
    : [deviceInstallId, namespace, identityPath, 'account-scoped-v2', principalId];
  const fingerprint = createHash('sha256').update(parts.join('\0')).digest('hex');
  const ownerKey = `owner_${fingerprint}`;
  return {
    ownerKey, namespace, deviceInstallId, canonicalWorkspacePath: canonical,
    cacheDirectory, versionDirectory, ownersDirectory, ownerDirectory: path.join(ownersDirectory, ownerKey)
  };
}
