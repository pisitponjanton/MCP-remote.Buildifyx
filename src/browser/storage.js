import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rm, rmdir, stat, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { buildifyxHome } from '../utils/home.js';
import { assertExistingPrivateDirectory, ensurePrivateDirectory, resolveCacheOwner } from '../cache/identity.js';

const ID = /^bs_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const PROFILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const KEY = /^profile_[0-9a-f]{64}$/;
const READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function assertSessionId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw failure('BROWSER_INVALID_SESSION', 'Invalid browser session id.');
}
async function regularFile(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw failure('BROWSER_UNSAFE_PATH', 'Unsafe browser metadata file.');
  return info;
}
async function readMetadata(filename, maxBytes = 4096) {
  const before = await regularFile(filename);
  if (before.size > maxBytes) throw failure('BROWSER_INVALID_STATE', 'Browser session metadata exceeds limit.');
  const handle = await open(filename, READ);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== before.ino || current.dev !== before.dev || current.nlink !== 1) {
      throw failure('BROWSER_UNSAFE_PATH', 'Browser metadata changed during read.');
    }
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error?.code === 'BROWSER_UNSAFE_PATH') throw error;
    throw failure('BROWSER_INVALID_STATE', 'Invalid browser session metadata.');
  } finally { await handle.close(); }
}
async function writeNewJson(filename, record) {
  const handle = await open(filename, CREATE, 0o600);
  try { await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}
async function assertOwnedDirectory(directory) {
  await assertExistingPrivateDirectory(directory);
  const canonical = await realpath(directory);
  // The parent may have legitimate OS aliases (/var -> /private/var on macOS).
  // Compare against the resolved parent, not the original uncanonicalized string.
  const parent = await realpath(path.dirname(directory));
  if (canonical !== path.join(parent, path.basename(directory))) {
    throw failure('BROWSER_UNSAFE_PATH', 'Browser directory changed its parent or is linked.');
  }
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}
async function safeRemoveOwnedDirectory(directory) {
  await assertOwnedDirectory(directory);
  // Generated browser data is recursively removed, but only beneath a verified
  // first-party, session-specific directory. Node rm does not follow symlink entries.
  await rm(directory, { recursive: true, force: false, maxRetries: 2 });
}

export function createBrowserStorage({ workspaceRoot, namespace = 'cloud', principalId = 'internal', legacyPrincipalId = null, homeDirectory = buildifyxHome() }) {
  const validPrincipal = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
  if (!validPrincipal(principalId) || (legacyPrincipalId !== null && !validPrincipal(legacyPrincipalId))) {
    throw new TypeError('Invalid browser storage principal.');
  }
  let promise;
  function ownerKey(cacheOwnerKey, value) {
    return 'owner_' + createHash('sha256').update(cacheOwnerKey + '\0' + value).digest('hex');
  }
  async function init() {
    promise ??= (async () => {
      const cacheOwner = await resolveCacheOwner({ workspaceRoot, namespace, homeDirectory });
      // Browser profiles are principal-private even for the same workspace and device.
      const owner = { ...cacheOwner, ownerKey: ownerKey(cacheOwner.ownerKey, principalId) };
      const base = path.join(homeDirectory, 'browser');
      const version = path.join(base, 'v1');
      const sessionsRoot = path.join(version, 'sessions');
      const profilesRoot = path.join(version, 'profiles');
      for (const d of [base, version, sessionsRoot, profilesRoot]) await ensurePrivateDirectory(d);
      const sessions = path.join(sessionsRoot, owner.ownerKey);
      const profiles = path.join(profilesRoot, owner.ownerKey);
      for (const d of [sessions, profiles]) await ensurePrivateDirectory(d);
      const legacyProfiles = legacyPrincipalId && legacyPrincipalId !== principalId
        ? path.join(profilesRoot, ownerKey(cacheOwner.ownerKey, legacyPrincipalId)) : null;
      return { owner, base, version, sessionsRoot, profilesRoot, sessions, profiles, legacyProfiles };
    })().catch(error => { promise = null; throw error; });
    return promise;
  }
  async function validate(state) {
    for (const directory of [state.base, state.version, state.sessionsRoot,
      state.profilesRoot, state.sessions, state.profiles]) await assertOwnedDirectory(directory);
  }
  async function createTemporary() {
    const state = await init(); await validate(state);
    const id = 'bs_' + randomUUID();
    const directory = path.join(state.sessions, id);
    await ensurePrivateDirectory(directory);
    const record = { version: 1, id, ownerKey: state.owner.ownerKey, pid: process.pid, createdAt: Date.now() };
    try {
      await writeNewJson(path.join(directory, 'session.json'), record);
      const userDataDir = path.join(directory, 'chromium');
      await ensurePrivateDirectory(userDataDir);
      return { id, directory, userDataDir };
    } catch (error) {
      await safeRemoveOwnedDirectory(directory).catch(() => undefined);
      throw error;
    }
  }
  async function removeTemporary(id) {
    assertSessionId(id);
    const state = await init(); await validate(state);
    const directory = path.join(state.sessions, id);
    try { await assertOwnedDirectory(directory); }
    catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
    const meta = await readMetadata(path.join(directory, 'session.json'));
    if (meta?.version !== 1 || meta.id !== id || meta.ownerKey !== state.owner.ownerKey || !Number.isInteger(meta.pid)) {
      throw failure('BROWSER_INVALID_STATE', 'Untrusted temporary session metadata.');
    }
    await safeRemoveOwnedDirectory(directory);
    return true;
  }
  async function cleanupOrphans() {
    const state = await init(); await validate(state);
    let removed = 0;
    for (const entry of await readdir(state.sessions, { withFileTypes: true })) {
      assertSessionId(entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw failure('BROWSER_UNSAFE_PATH', 'Unexpected temporary session entry.');
      const directory = path.join(state.sessions, entry.name);
      await assertOwnedDirectory(directory);
      const meta = await readMetadata(path.join(directory, 'session.json'));
      if (meta?.version !== 1 || meta?.id !== entry.name || meta?.ownerKey !== state.owner.ownerKey) {
        throw failure('BROWSER_INVALID_STATE', 'Refusing to remove unknown browser state.');
      }
      if (!pidAlive(meta.pid)) { await removeTemporary(entry.name); removed++; }
    }
    return { removed };
  }
  function profileKey(name) {
    if (typeof name !== 'string' || !PROFILE.test(name) || name === '.' || name === '..') {
      throw failure('BROWSER_INVALID_PROFILE', 'Profile names must contain only letters, digits, dots, underscores or hyphens.');
    }
    return 'profile_' + createHash('sha256').update(name).digest('hex');
  }
  async function profileDirectory(name) {
    const state = await init(); await validate(state);
    const key = profileKey(name);
    const directory = path.join(state.profiles, key);
    await ensurePrivateDirectory(directory);
    const dataDirectory = path.join(directory, 'chromium');
    await ensurePrivateDirectory(dataDirectory);
    return { directory, dataDirectory, key, ownerKey: state.owner.ownerKey };
  }
  async function migrateLegacyProfile(name) {
    const state = await init(); await validate(state);
    // Called only after explicit persistent-profile consent and after securing
    // the new owner's profile lock. Old identities derived from the *current*
    // authenticated device token; never enumerate or assign unknown owners.
    if (!state.legacyProfiles) return false;
    const key = profileKey(name);
    const destination = path.join(state.profiles, key);
    const source = path.join(state.legacyProfiles, key);
    const targetExists = await lstat(destination).then(() => true, error => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    if (targetExists) return false;
    const oldExists = await lstat(state.legacyProfiles).then(() => true, error => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    if (!oldExists) return false;
    await assertOwnedDirectory(state.legacyProfiles);
    const sourceExists = await lstat(source).then(() => true, error => {
      if (error?.code === 'ENOENT') return false;
      throw error;
    });
    if (!sourceExists) return false;
    // Acquire the old owner's lock exclusively for the entire migration.
    // This prevents an older Agent from launching Chromium during the scan.
    // Existing live or stale locks are never deleted or recovered here.
    const oldLockDirectory = path.join(state.legacyProfiles, key + '.lock');
    try { await mkdir(oldLockDirectory, { mode: 0o700 }); }
    catch (error) {
      if (error?.code === 'EEXIST') throw failure('BROWSER_PROFILE_IN_USE', 'Legacy profile is locked; migration refused.');
      throw error;
    }
    try {
      await assertOwnedDirectory(source);
    let visited = 0;
    async function validateTree(directory) {
      if (++visited > 20000) throw failure('BROWSER_INVALID_STATE', 'Legacy browser profile is too large to validate.');
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, item.name);
        const info = await lstat(filename);
        if (info.isSymbolicLink()) throw failure('BROWSER_UNSAFE_PATH', 'Legacy browser profile contains a symbolic link.');
        if (info.isDirectory()) { await assertOwnedDirectory(filename); await validateTree(filename); }
        else if (!info.isFile() || info.nlink !== 1) throw failure('BROWSER_UNSAFE_PATH', 'Legacy browser profile contains unsafe files.');
        if (++visited > 20000) throw failure('BROWSER_INVALID_STATE', 'Legacy browser profile is too large to validate.');
      }
    }
    await validateTree(source);
    // A stable-owner lock is held by the engine, preventing concurrent
    // migrations. Both directories are beneath the same private browser root.
    // Atomic rename preserves Chromium state without exposing/copying cookies
    // to Cloud. Never overwrite an existing stable profile.
    const destinationNow = await lstat(destination).then(() => true, error =>
      error?.code === 'ENOENT' ? false : Promise.reject(error));
    if (destinationNow) return false;
    await rename(source, destination);
      return true;
    } finally {
      // Only remove our own empty migration lock; never the user profile.
      await assertOwnedDirectory(oldLockDirectory);
      await rmdir(oldLockDirectory);
    }
  }
  async function acquireProfileLock(name) {
    const state = await init(); await validate(state);
    const key = profileKey(name);
    const lockDirectory = path.join(state.profiles, key + '.lock');
    const recoveryDirectory = path.join(state.profiles, key + '.recover');
    const attempt = async () => {
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
        return true;
      } catch (error) {
        if (error?.code === 'EEXIST') return false;
        throw error;
      }
    };
    if (!await attempt()) {
      // Another process may be using this profile. Never remove a live lock.
      const old = await readMetadata(path.join(lockDirectory, 'owner.json')).catch(error => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (!old || pidAlive(old.pid)) throw failure('BROWSER_PROFILE_IN_USE', 'Profile is in use or lock ownership is uncertain.');
      try { await mkdir(recoveryDirectory, { mode: 0o700 }); }
      catch (error) {
        if (error?.code === 'EEXIST') throw failure('BROWSER_PROFILE_IN_USE', 'Profile lock is being recovered.');
        throw error;
      }
      try {
        const latest = await readMetadata(path.join(lockDirectory, 'owner.json'));
        if (latest.token !== old.token || pidAlive(latest.pid)) throw failure('BROWSER_PROFILE_IN_USE', 'Profile lock changed.');
        await assertOwnedDirectory(lockDirectory);
        await rm(lockDirectory, { recursive: true });
      } finally { await rmdir(recoveryDirectory).catch(() => undefined); }
      if (!await attempt()) throw failure('BROWSER_PROFILE_IN_USE', 'Profile is already locked.');
    }
    const token = randomUUID();
    try {
      await writeNewJson(path.join(lockDirectory, 'owner.json'), { pid: process.pid, token });
    } catch (error) { await rm(lockDirectory, { recursive: true }).catch(() => undefined); throw error; }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const latest = await readMetadata(path.join(lockDirectory, 'owner.json')).catch(() => null);
      if (latest?.token !== token) throw failure('BROWSER_PROFILE_IN_USE', 'Browser profile lock identity changed.');
      await assertOwnedDirectory(lockDirectory);
      await rm(lockDirectory, { recursive: true });
    };
  }
  async function readProfileState(name) {
    const { directory } = await profileDirectory(name);
    const file = path.join(directory, 'browser-state.json');
    let state;
    try { state = await readMetadata(file, 300_000); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    if (state?.version !== 1 || !Array.isArray(state.cookies) || state.cookies.length > 512
      || !state.cookies.every(c => c && typeof c.name === 'string' && typeof c.value === 'string'
        && typeof c.domain === 'string' && typeof c.path === 'string')) {
      throw failure('BROWSER_INVALID_STATE', 'Persistent browser snapshot is invalid.');
    }
    return state.cookies;
  }
  async function saveProfileState(name, cookies) {
    if (!Array.isArray(cookies) || cookies.length > 512) throw failure('BROWSER_INVALID_STATE', 'Too many browser cookies.');
    const { directory } = await profileDirectory(name);
    const destination = path.join(directory, 'browser-state.json');
    const staged = path.join(directory, '.state-' + randomUUID());
    const serialized = JSON.stringify({ version: 1, cookies });
    if (Buffer.byteLength(serialized) > 256 * 1024) throw failure('BROWSER_INVALID_STATE', 'Persistent browser state is too large.');
    await writeNewJson(staged, { version: 1, cookies });
    try {
      await assertOwnedDirectory(directory);
      const existing = await lstat(destination).catch(e => e?.code === 'ENOENT' ? null : Promise.reject(e));
      if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
        throw failure('BROWSER_UNSAFE_PATH', 'Unsafe persistent browser state.');
      }
      const { rename } = await import('node:fs/promises');
      await rename(staged, destination);
    } finally { await rm(staged, { force: true }).catch(() => undefined); }
  }
  return { init, createTemporary, removeTemporary, cleanupOrphans, profileDirectory, acquireProfileLock, migrateLegacyProfile, profileKey, readProfileState, saveProfileState };
}
