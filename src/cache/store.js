import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rmdir, stat, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { buildifyxHome } from '../utils/home.js';
import {
  ARTIFACT_ID_PATTERN, CACHE_SCHEMA_VERSION, DEFAULT_CACHE_QUOTA_BYTES,
  DEFAULT_CACHE_TTL_MS, DEFAULT_MAX_ARTIFACT_BYTES, OWNER_KEY_PATTERN,
  assertExistingPrivateDirectory, ensurePrivateDirectory, resolveCacheOwner
} from './identity.js';

const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 15_000;
const LEASE_STALE_MS = 90_000;
const LEASE_HEARTBEAT_MS = 15_000;
const LOCK_HEARTBEAT_MS = 10_000;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
const metaName = (id) => `${id}.json`;
const dataName = (id) => `${id}.bin`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cacheError(code, message) {
  return Object.assign(new Error(message), { code });
}
function assertId(id) {
  if (typeof id !== 'string' || !ARTIFACT_ID_PATTERN.test(id)) {
    throw cacheError('CACHE_INVALID_ID', 'Invalid artifact identifier.');
  }
}
function validPositiveNumber(number) {
  return Number.isSafeInteger(number) && number > 0;
}
function assertConfiguration({ ttlMs, quotaBytes, maxArtifactBytes, cleanupIntervalMs }) {
  if (!validPositiveNumber(ttlMs) || !validPositiveNumber(quotaBytes)
      || !validPositiveNumber(maxArtifactBytes) || maxArtifactBytes > quotaBytes
      || !validPositiveNumber(cleanupIntervalMs)) {
    throw new TypeError('Invalid artifact cache limits.');
  }
}
async function regularFile(filename) {
  const entry = await lstat(filename);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
    throw cacheError('CACHE_UNSAFE_PATH', 'Unsafe cache file.');
  }
  return entry;
}
async function readSafe(filename, limit) {
  const before = await regularFile(filename);
  if (before.size > limit) throw cacheError('CACHE_INVALID_DATA', 'Cache entry exceeds allowed size.');
  const handle = await open(filename, READ_FLAGS);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.nlink !== 1 || actual.ino !== before.ino || actual.dev !== before.dev) {
      throw cacheError('CACHE_UNSAFE_PATH', 'Cache file changed while opening.');
    }
    return await handle.readFile();
  } finally { await handle.close(); }
}
async function safeUnlink(filename) {
  try {
    await regularFile(filename);
    await unlink(filename);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
async function atomicFile(directory, destination, data) {
  const temp = path.join(directory, `.tmp-${randomUUID()}`);
  const handle = await open(temp, WRITE_FLAGS, 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await safeUnlink(temp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    // All final basenames are generated opaque IDs; never accept a caller-supplied destination.
    try { await lstat(destination); throw cacheError('CACHE_EXISTS', 'Artifact already exists.'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await rename(temp, destination);
  } finally { await safeUnlink(temp).catch(() => undefined); }
}
function parseMetadata(buffer, id, ownerKey) {
  let value;
  try { value = JSON.parse(buffer.toString('utf8')); } catch { return null; }
  if (value?.schemaVersion !== CACHE_SCHEMA_VERSION || value.id !== id
    || value.ownerKey !== ownerKey || !validPositiveNumber(value.size)
    || !/^[0-9a-f]{64}$/.test(value.sha256 ?? '')
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= value.createdAt || typeof value.pinned !== 'boolean'
    || !['image', 'screenshot', 'transfer'].includes(value.kind)
    || typeof value.mimeType !== 'string' || value.mimeType.length > 128
    || !['capture', 'import', 'generated', 'generated-safe', 'other'].includes(value.origin)) return null;
  return value;
}
function publicMetadata(record) {
  const { schemaVersion, ownerKey, ...publicRecord } = record;
  return { ...publicRecord };
}

export function createArtifactCache({
  workspaceRoot,
  namespace = 'cloud',
  principalId = null,
  homeDirectory = buildifyxHome(),
  ttlMs = DEFAULT_CACHE_TTL_MS,
  quotaBytes = DEFAULT_CACHE_QUOTA_BYTES,
  maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
  cleanupIntervalMs = 5 * 60_000,
  audit = () => {},
  now = () => Date.now()
} = {}) {
  assertConfiguration({ ttlMs, quotaBytes, maxArtifactBytes, cleanupIntervalMs });
  let setupPromise = null;
  let cleanupTimer = null;
  let owner = null;
  let boundPrincipal = principalId;
  function bindPrincipal(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new TypeError('Invalid cache principal.');
    if (boundPrincipal !== null && boundPrincipal !== value) throw new TypeError('Artifact cache is bound to another principal.');
    if (setupPromise && boundPrincipal !== value) throw new TypeError('Cannot change an initialized artifact cache owner.');
    boundPrincipal = value;
  }

  function emitDeletion(record, reason) {
    // Only identifiers, sizes and deletion causes are emitted. No bytes, locations or tokens.
    try { audit({ type: 'artifact.deleted', id: record.id, ownerKey: record.ownerKey, size: record.size, reason }); } catch {}
  }
  function paths(ownerDirectory) {
    return {
      meta: path.join(ownerDirectory, 'meta'),
      data: path.join(ownerDirectory, 'data'),
      leases: path.join(ownerDirectory, 'leases'),
      tmp: path.join(ownerDirectory, 'tmp')
    };
  }
  async function setup() {
    if (!setupPromise) {
      setupPromise = (async () => {
        const resolved = await resolveCacheOwner({ workspaceRoot, namespace, principalId: boundPrincipal, homeDirectory });
        await ensurePrivateDirectory(resolved.ownerDirectory);
        const dirs = paths(resolved.ownerDirectory);
        for (const dir of Object.values(dirs)) await ensurePrivateDirectory(dir);
        owner = resolved;
        return resolved;
      })().catch((error) => { setupPromise = null; throw error; });
    }
    return setupPromise;
  }
  async function validateLayout(current) {
    const directories = [current.cacheDirectory, current.versionDirectory, current.ownersDirectory, current.ownerDirectory, ...Object.values(paths(current.ownerDirectory))];
    for (const directory of directories) await assertExistingPrivateDirectory(directory);
  }
  async function withLock(callback) {
    const current = await setup();
    await validateLayout(current);
    const lockDir = path.join(current.versionDirectory, '.cache.lock');
    const started = Date.now();
    while (true) {
      try { await mkdir(lockDir, { mode: 0o700 }); break; }
      catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const info = await lstat(lockDir).catch((e) => e?.code === 'ENOENT' ? null : Promise.reject(e));
        if (!info) continue;
        if (info.isSymbolicLink() || !info.isDirectory()) throw cacheError('CACHE_UNSAFE_PATH', 'Unsafe cache lock.');
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rmdir(lockDir).catch((e) => { if (e?.code !== 'ENOENT') throw e; });
          continue;
        }
        if (Date.now() - started > LOCK_WAIT_MS) throw cacheError('CACHE_LOCK_TIMEOUT', 'Timed out waiting for cache lock.');
        await sleep(20);
      }
    }
    const heartbeat = setInterval(() => { void utimes(lockDir, new Date(), new Date()).catch(() => undefined); }, LOCK_HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
      await validateLayout(current);
      return await callback(current);
    }
    finally {
      clearInterval(heartbeat);
      await rmdir(lockDir).catch((e) => { if (e?.code !== 'ENOENT') throw e; });
    }
  }
  async function activeLease(dirs, id) {
    const list = await readdir(dirs.leases);
    let active = false;
    for (const filename of list) {
      if (!filename.startsWith(`${id}.`) || !filename.endsWith('.lease')) continue;
      const full = path.join(dirs.leases, filename);
      const info = await regularFile(full).catch((e) => e?.code === 'ENOENT' ? null : Promise.reject(e));
      if (!info) continue;
      if (Date.now() - info.mtimeMs > LEASE_STALE_MS) await safeUnlink(full);
      else active = true;
    }
    return active;
  }
  async function deleteRecord(dirs, record, reason) {
    if (await activeLease(dirs, record.id)) return false;
    await safeUnlink(path.join(dirs.meta, metaName(record.id)));
    await safeUnlink(path.join(dirs.data, dataName(record.id)));
    emitDeletion(record, reason);
    return true;
  }
  async function scan({ clean = false } = {}) {
    const current = await setup();
    const records = [];
    const owners = await readdir(current.ownersDirectory, { withFileTypes: true });
    for (const item of owners) {
      if (!OWNER_KEY_PATTERN.test(item.name)) throw cacheError('CACHE_UNSAFE_PATH', 'Unknown cache owner directory entry.');
      const ownerDirectory = path.join(current.ownersDirectory, item.name);
      if (!item.isDirectory() || item.isSymbolicLink()) throw cacheError('CACHE_UNSAFE_PATH', 'Unsafe cache owner directory.');
      const dirs = paths(ownerDirectory);
      for (const directory of Object.values(dirs)) await ensurePrivateDirectory(directory);

      if (clean) {
        for (const lease of await readdir(dirs.leases)) {
          if (!/^art_[0-9a-f-]{36}\.[0-9a-f-]{36}\.lease$/.test(lease)) throw cacheError('CACHE_UNSAFE_PATH', 'Unknown cache lease entry.');
          const leasePath = path.join(dirs.leases, lease);
          const info = await regularFile(leasePath).catch((e) => e?.code === 'ENOENT' ? null : Promise.reject(e));
          if (info && Date.now() - info.mtimeMs > LEASE_STALE_MS) await safeUnlink(leasePath);
        }
        for (const tmp of await readdir(dirs.tmp)) {
          const filename = path.join(dirs.tmp, tmp);
          const size = (await regularFile(filename)).size;
          if (await safeUnlink(filename)) emitDeletion({ id: null, ownerKey: item.name, size }, 'partial');
        }
        for (const filename of await readdir(dirs.data)) {
          if (!/^art_[0-9a-f-]{36}\.bin$/.test(filename)) throw cacheError('CACHE_UNSAFE_PATH', 'Unknown cache data entry.');
          const id = filename.slice(0, -4);
          if (!ARTIFACT_ID_PATTERN.test(id)) throw cacheError('CACHE_UNSAFE_PATH', 'Malformed cache data entry.');
          try { await regularFile(path.join(dirs.meta, metaName(id))); }
          catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            if (!await activeLease(dirs, id)) {
              const size = (await regularFile(path.join(dirs.data, filename))).size;
              if (await safeUnlink(path.join(dirs.data, filename))) emitDeletion({ id, ownerKey: item.name, size }, 'orphan');
            }
          }
        }
      }
      for (const filename of await readdir(dirs.meta)) {
        if (!/^art_[0-9a-f-]{36}\.json$/.test(filename)) throw cacheError('CACHE_UNSAFE_PATH', 'Unknown cache metadata entry.');
        const id = filename.slice(0, -5);
        assertId(id);
        const metaPath = path.join(dirs.meta, filename);
        const record = parseMetadata(await readSafe(metaPath, 8192), id, item.name);
        if (!record) {
          if (clean && !await activeLease(dirs, id)) {
            const damaged = await regularFile(path.join(dirs.data, dataName(id))).catch((e) => e?.code === 'ENOENT' ? null : Promise.reject(e));
            await safeUnlink(metaPath);
            await safeUnlink(path.join(dirs.data, dataName(id)));
            emitDeletion({ id, ownerKey: item.name, size: damaged?.size ?? 0 }, 'invalid');
          }
          continue;
        }
        let actual;
        try { actual = await regularFile(path.join(dirs.data, dataName(id))); }
        catch (error) { if (error?.code !== 'ENOENT') throw error; }
        if (!actual || actual.size !== record.size) {
          if (clean && !await activeLease(dirs, id)) await deleteRecord(dirs, record, 'invalid');
          continue;
        }
        if (clean && record.expiresAt <= now()) {
          if (await deleteRecord(dirs, record, 'expired')) continue;
        }
        records.push({ record, dirs, size: actual.size });
      }
    }
    return records;
  }
  async function reclaim(requiredBytes = 0) {
    const records = await scan({ clean: true });
    let used = records.reduce((sum, entry) => sum + entry.size, 0);
    let evicted = 0;
    if (used + requiredBytes > quotaBytes) {
      // Preserve the global device quota, but an authenticated account can
      // evict only its own artifacts. Otherwise the new account could flush
      // another user's private cache simply by exhausting shared disk quota.
      const candidates = records.filter(entry => !entry.record.pinned
        && (boundPrincipal === null || entry.record.ownerKey === owner.ownerKey))
        .sort((a, b) => a.record.createdAt - b.record.createdAt || a.record.id.localeCompare(b.record.id));
      for (const candidate of candidates) {
        if (used + requiredBytes <= quotaBytes) break;
        if (await deleteRecord(candidate.dirs, candidate.record, 'quota')) {
          used -= candidate.size;
          evicted++;
        }
      }
    }
    if (used + requiredBytes > quotaBytes) throw cacheError('CACHE_QUOTA_EXCEEDED', 'Cache quota exhausted by pinned or leased artifacts.');
    return { usageBytes: used, evicted };
  }
  async function ownedRecord(current, id) {
    assertId(id);
    const dirs = paths(current.ownerDirectory);
    let file;
    try { file = await readSafe(path.join(dirs.meta, metaName(id)), 8192); }
    catch (error) { if (error?.code === 'ENOENT') throw cacheError('CACHE_NOT_FOUND', 'Artifact not found.'); throw error; }
    const record = parseMetadata(file, id, current.ownerKey);
    if (!record || record.expiresAt <= now()) throw cacheError('CACHE_NOT_FOUND', 'Artifact not found or expired.');
    const info = await regularFile(path.join(dirs.data, dataName(id)));
    if (info.size !== record.size) throw cacheError('CACHE_CORRUPT', 'Cache data size mismatch.');
    return { record, dirs };
  }
  async function put({ data, kind = 'image', mimeType = 'application/octet-stream', origin = 'other', expiresInMs = ttlMs, pinned = false } = {}) {
    if (!(Buffer.isBuffer(data) || data instanceof Uint8Array)) throw new TypeError('Cache data must be bytes.');
    const bytes = Buffer.from(data);
    if (!bytes.length || bytes.length > maxArtifactBytes) throw cacheError('CACHE_INVALID_DATA', 'Artifact size is out of bounds.');
    if (!['image', 'screenshot', 'transfer'].includes(kind) || !['capture', 'import', 'generated', 'generated-safe', 'other'].includes(origin)
      || typeof mimeType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType) || mimeType.length > 128
      || !validPositiveNumber(expiresInMs) || typeof pinned !== 'boolean') throw new TypeError('Invalid artifact metadata.');
    return withLock(async (current) => {
      await reclaim(bytes.length);
      const id = `art_${randomUUID()}`;
      const dirs = paths(current.ownerDirectory);
      const createdAt = now();
      const record = {
        schemaVersion: CACHE_SCHEMA_VERSION, id, ownerKey: current.ownerKey,
        kind, mimeType, origin, size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        createdAt, expiresAt: createdAt + expiresInMs, pinned
      };
      if (!Number.isSafeInteger(record.expiresAt)) throw new TypeError('Invalid artifact expiry.');
      const dataPath = path.join(dirs.data, dataName(id));
      try {
        await atomicFile(dirs.tmp, dataPath, bytes);
        await atomicFile(dirs.tmp, path.join(dirs.meta, metaName(id)), Buffer.from(JSON.stringify(record) + '\n'));
      } catch (error) {
        await safeUnlink(dataPath).catch(() => undefined);
        throw error;
      }
      return publicMetadata(record);
    });
  }
  async function withLease(id, callback) {
    if (typeof callback !== 'function') throw new TypeError('Lease callback must be a function.');
    let leasePath;
    let currentRecord;
    let dirs;
    await withLock(async (current) => {
      const found = await ownedRecord(current, id);
      currentRecord = found.record;
      dirs = found.dirs;
      leasePath = path.join(dirs.leases, `${id}.${randomUUID()}.lease`);
      const handle = await open(leasePath, WRITE_FLAGS, 0o600);
      await handle.close();
    });
    let active = true;
    const pulse = setInterval(() => { void utimes(leasePath, new Date(), new Date()).catch(() => undefined); }, LEASE_HEARTBEAT_MS);
    pulse.unref?.();
    try {
      return await callback({
        metadata: publicMetadata(currentRecord),
        read: async () => {
          if (!active) throw cacheError('CACHE_LEASE_CLOSED', 'Artifact lease has closed.');
          await assertExistingPrivateDirectory(dirs.data);
          const bytes = await readSafe(path.join(dirs.data, dataName(id)), maxArtifactBytes);
          if (bytes.length !== currentRecord.size || createHash('sha256').update(bytes).digest('hex') !== currentRecord.sha256) {
            throw cacheError('CACHE_CORRUPT', 'Artifact integrity check failed.');
          }
          return bytes;
        }
      });
    } finally {
      active = false;
      clearInterval(pulse);
      await assertExistingPrivateDirectory(dirs.leases);
      await safeUnlink(leasePath);
    }
  }
  async function get(id) {
    return withLease(id, async ({ metadata, read }) => ({ metadata, data: await read() }));
  }
  async function list() {
    return withLock(async (current) => {
      await reclaim();
      const all = await scan();
      return all.filter((entry) => entry.record.ownerKey === current.ownerKey)
        .map((entry) => publicMetadata(entry.record))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    });
  }
  async function remove(id) {
    return withLock(async (current) => {
      let found;
      try { found = await ownedRecord(current, id); }
      catch (error) { if (error?.code === 'CACHE_NOT_FOUND') return false; throw error; }
      if (!await deleteRecord(found.dirs, found.record, 'explicit')) throw cacheError('CACHE_IN_USE', 'Artifact is currently leased.');
      return true;
    });
  }
  async function clear() {
    return withLock(async (current) => {
      const entries = await scan({ clean: true });
      let removed = 0;
      for (const entry of entries) {
        if (entry.record.ownerKey === current.ownerKey && await deleteRecord(entry.dirs, entry.record, 'clear')) removed++;
      }
      return { removed };
    });
  }
  async function setPinned(id, pinned) {
    if (typeof pinned !== 'boolean') throw new TypeError('Pinned must be a boolean.');
    return withLock(async (current) => {
      const { record, dirs } = await ownedRecord(current, id);
      if (await activeLease(dirs, id)) throw cacheError('CACHE_IN_USE', 'Cannot update a leased artifact.');
      record.pinned = pinned;
      const staged = path.join(dirs.tmp, `pin-${randomUUID()}`);
      await atomicFile(dirs.tmp, staged, Buffer.from(JSON.stringify(record) + '\n'));
      try { await rename(staged, path.join(dirs.meta, metaName(id))); }
      finally { await safeUnlink(staged).catch(() => undefined); }
      return publicMetadata(record);
    });
  }
  async function prune() {
    return withLock(async () => reclaim());
  }
  async function initialize({ periodic = false } = {}) {
    const result = await prune();
    if (periodic && !cleanupTimer) {
      cleanupTimer = setInterval(() => { void prune().catch(() => undefined); }, cleanupIntervalMs);
      cleanupTimer.unref?.();
    }
    return result;
  }
  function close() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  return {
    initialize, put, get, withLease, list, remove, clear, setPinned, prune, close, bindPrincipal,
    async identity() {
      const { ownerKey, namespace: ownerNamespace, deviceInstallId } = await setup();
      return { ownerKey, namespace: ownerNamespace, deviceInstallId };
    }
  };
}
