import { randomUUID } from 'node:crypto';
import { AgentError } from '../core/errors.js';
import { createBrowserStorage } from './storage.js';

export const DEFAULT_BROWSER_IDLE_MS = 30 * 60 * 1000;
export const DEFAULT_BROWSER_SESSIONS = 3;
export const DEFAULT_BROWSER_TIMEOUT_MS = 30_000;
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION = /^browser_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function issue(code, message) { return new AgentError(code, message); }
// Avoid returning raw Playwright launch errors: they may expose OS paths or
// environment details. Distinguish missing Linux system libraries from a
// missing browser download so users are not directed to reinstall Chromium.
export function browserLaunchFailure(error, platform = process.platform) {
  const diagnostic = typeof error?.message === 'string' ? error.message : '';
  const missingLinuxLibraries = platform === 'linux'
    && /Host system is missing dependencies to run browsers|Missing libraries|lib(?:gbm|cairo|pango|asound|nss3|atk)[^\s]*\.so/i.test(diagnostic);
  return issue('BROWSER_LAUNCH_FAILED', missingLinuxLibraries
    ? 'Chromium is installed but required Linux system libraries are missing. Install Playwright Chromium OS dependencies with administrator approval; see the Buildifyx v0.4.0 Browser guide.'
    : 'Could not launch Playwright Chromium. Run bdxa browser check, then bdxa browser install if the matching browser is missing.');
}
function isLoopback(host) {
  return host === 'localhost' || host.endsWith('.localhost')
    || host === '::1' || /^127(?:\.[0-9]{1,3}){3}$/.test(host);
}
export function validateBrowserUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw issue('BROWSER_INVALID_URL', 'Invalid browser URL.');
  let url;
  try { url = new URL(value); } catch { throw issue('BROWSER_INVALID_URL', 'Browser URL must be absolute.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw issue('BROWSER_INVALID_URL', 'Only HTTP(S) URLs without embedded credentials are permitted.');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isLoopback(host)) return url.toString();
  // Phase 6/8 must additionally check DNS resolution, redirects, popups and requests.
  if (!host || host.endsWith('.local') || host.endsWith('.internal') || host === '0.0.0.0'
    || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) || /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(host)
    || host.includes(':')) {
    throw issue('BROWSER_URL_DENIED', 'Private-network browser targets require separate authorization.');
  }
  return url.toString();
}

export function createBrowserSessionEngine({
  workspaceRoot, namespace = 'cloud', instanceId, principalId,
  storagePrincipalId = principalId, legacyStoragePrincipalId = null,
  homeDirectory, chromium: browserAdapter,
  persistentConsent = async () => false,
  now = () => Date.now(),
  idleMs = DEFAULT_BROWSER_IDLE_MS,
  maxSessions = DEFAULT_BROWSER_SESSIONS,
  launchTimeoutMs = DEFAULT_BROWSER_TIMEOUT_MS,
  sweepMs = 60_000
} = {}) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()
    || typeof instanceId !== 'string' || !IDENT.test(instanceId)
    || typeof principalId !== 'string' || !IDENT.test(principalId)
    || typeof storagePrincipalId !== 'string' || !IDENT.test(storagePrincipalId)
    || (legacyStoragePrincipalId !== null && (typeof legacyStoragePrincipalId !== 'string' || !IDENT.test(legacyStoragePrincipalId)))
    || !Number.isSafeInteger(idleMs) || idleMs < 1
    || !Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 8
    || !Number.isSafeInteger(launchTimeoutMs) || launchTimeoutMs < 1
    || !Number.isSafeInteger(sweepMs) || sweepMs < 1
    || typeof persistentConsent !== 'function') {
    throw new TypeError('Invalid browser engine owner, consent policy or limits.');
  }
  const storage = createBrowserStorage({ workspaceRoot, namespace, principalId: storagePrincipalId,
    legacyPrincipalId: legacyStoragePrincipalId, ...(homeDirectory ? { homeDirectory } : {}) });
  const sessions = new Map();
  const pending = new Set();
  let started = null;
  let timer = null;
  let stopping = false;
  let adapterPromise = null;
  async function adapter() {
    adapterPromise ??= (browserAdapter
      ? Promise.resolve(browserAdapter)
      : import('playwright').then(module => module.chromium)).catch(() => { adapterPromise = null; throw issue('BROWSER_DEPENDENCY_MISSING', 'Playwright Chromium is unavailable.'); });
    return adapterPromise;
  }
  function checkScope(scope) {
    if (scope?.instanceId !== instanceId || scope?.principalId !== principalId) {
      throw issue('BROWSER_ACCESS_DENIED', 'Browser session belongs to another requesting principal or instance.');
    }
  }
  function info(entry) {
    return { sessionId: entry.id, kind: entry.kind, profileKey: entry.kind === 'persistent' ? entry.profileKey : undefined,
      createdAt: entry.createdAt, lastUsedAt: entry.lastUsedAt, expiresAt: entry.lastUsedAt + idleMs,
      pageCount: entry.context.pages().length };
  }
  async function initialize() {
    started ??= storage.init().then(() => storage.cleanupOrphans()).catch(error => { started = null; throw error; });
    await started;
    if (!timer) {
      timer = setInterval(() => { void prune().catch(() => undefined); }, sweepMs);
      timer.unref?.();
    }
  }
  async function open({ scope, kind = 'temporary', profileName, confirmPersistent = false } = {}) {
    checkScope(scope);
    if (stopping) throw issue('BROWSER_STOPPING', 'Browser engine is closing.');
    if (kind !== 'temporary' && kind !== 'persistent') throw issue('BROWSER_INVALID_MODE', 'Invalid browser session mode.');
    if (kind === 'temporary' && profileName !== undefined) throw issue('BROWSER_INVALID_PROFILE', 'Temporary sessions cannot use a named profile.');
    if (kind === 'persistent') {
      if (confirmPersistent !== true || !await persistentConsent({ instanceId, principalId, workspaceRoot, profileName })) {
        throw issue('BROWSER_CONSENT_REQUIRED', 'Persistent profile requires explicit user approval.');
      }
    }
    await initialize();
    if (sessions.size + pending.size >= maxSessions) throw issue('BROWSER_SESSION_LIMIT', 'Too many active browser sessions.');
    const reservation = randomUUID();
    pending.add(reservation);
    let temp = null;
    let releaseProfile = null;
    let context = null;
    try {
      let userDataDir, profileKey;
      if (kind === 'persistent') {
        profileKey = storage.profileKey(profileName);
        releaseProfile = await storage.acquireProfileLock(profileName);
        // Consent was already confirmed; move only this verified same-token
        // legacy profile into stable account storage, never unknown profiles.
        await storage.migrateLegacyProfile(profileName);
        ({ dataDirectory: userDataDir } = await storage.profileDirectory(profileName));
      } else {
        temp = await storage.createTemporary();
        userDataDir = temp.userDataDir;
      }
      const browser = await adapter();
      if (typeof browser?.launchPersistentContext !== 'function') throw issue('BROWSER_DEPENDENCY_MISSING', 'Playwright Chromium adapter is invalid.');
      try {
        context = await browser.launchPersistentContext(userDataDir, {
          headless: true, timeout: launchTimeoutMs, acceptDownloads: false,
          serviceWorkers: 'block', ignoreHTTPSErrors: false,
          permissions: [], bypassCSP: false, javaScriptEnabled: true
        });
      } catch (error) {
        throw browserLaunchFailure(error);
      }
      if (kind === 'persistent') {
        try {
          const restored = await storage.readProfileState(profileName);
          if (restored?.length) await context.addCookies(restored);
        } catch { throw issue('BROWSER_STATE_RESTORE_FAILED', 'Could not safely restore the local browser profile.'); }
      }
      if (stopping) throw issue('BROWSER_STOPPING', 'Browser engine is closing.');
      const id = 'browser_' + randomUUID();
      const entry = { id, kind, profileName, profileKey, context, tempId: temp?.id, releaseProfile,
        createdAt: now(), lastUsedAt: now(), inUse: 0, closing: false };
      sessions.set(id, entry);
      return info(entry);
    } catch (error) {
      await context?.close().catch(() => undefined);
      if (temp) await storage.removeTemporary(temp.id).catch(() => undefined);
      if (releaseProfile) await releaseProfile().catch(() => undefined);
      throw error;
    } finally { pending.delete(reservation); }
  }
  async function getEntry(id, scope) {
    checkScope(scope);
    if (typeof id !== 'string' || !SESSION.test(id)) throw issue('BROWSER_INVALID_SESSION', 'Invalid browser session id.');
    const entry = sessions.get(id);
    if (!entry || entry.closing || stopping) throw issue('BROWSER_SESSION_NOT_FOUND', 'Browser session is not active.');
    if (now() - entry.lastUsedAt >= idleMs && entry.inUse === 0) {
      await closeSession(id, { scope });
      throw issue('BROWSER_SESSION_EXPIRED', 'Browser session has expired.');
    }
    entry.lastUsedAt = now();
    return entry;
  }
  async function withSession(id, callback, { scope } = {}) {
    if (typeof callback !== 'function') throw new TypeError('Browser session callback is required.');
    const entry = await getEntry(id, scope);
    entry.inUse++;
    try {
      if (entry.closing) throw issue('BROWSER_SESSION_NOT_FOUND', 'Browser session is closing.');
      return await callback({ context: entry.context, pages: entry.context.pages(), kind: entry.kind });
    } finally { entry.inUse--; entry.lastUsedAt = now(); }
  }
  async function list({ scope } = {}) {
    checkScope(scope);
    if (stopping) return [];
    await prune();
    return [...sessions.values()].filter(s => !s.closing).map(info);
  }
  async function closeSession(id, { scope, force = false } = {}) {
    checkScope(scope);
    if (typeof id !== 'string' || !SESSION.test(id)) throw issue('BROWSER_INVALID_SESSION', 'Invalid browser session id.');
    const entry = sessions.get(id);
    if (!entry || entry.closing) return false;
    if (entry.inUse && !force) throw issue('BROWSER_IN_USE', 'Browser session has an active operation.');
    entry.closing = true;
    sessions.delete(id);
    let failure = null;
    if (entry.kind === 'persistent') {
      try { await storage.saveProfileState(entry.profileName, await entry.context.cookies()); }
      catch (error) { failure = error; }
    }
    try { await entry.context.close(); }
    catch (error) { failure = error; }
    try {
      if (entry.tempId) await storage.removeTemporary(entry.tempId);
      if (entry.releaseProfile) await entry.releaseProfile();
    } catch (error) { failure ??= error; }
    if (failure) throw issue('BROWSER_CLEANUP_FAILED', 'Browser session cleanup could not complete safely.');
    return true;
  }
  async function prune() {
    if (stopping) return { closed: 0 };
    let closed = 0;
    const expired = [...sessions.values()].filter(s => !s.closing && !s.inUse && now() - s.lastUsedAt >= idleMs);
    for (const entry of expired) {
      if (await closeSession(entry.id, { scope: { instanceId, principalId } })) closed++;
    }
    return { closed };
  }
  async function closeAll() {
    stopping = true;
    if (timer) clearInterval(timer);
    timer = null;
    const ids = [...sessions.keys()];
    const errors = [];
    for (const id of ids) {
      try { await closeSession(id, { scope: { instanceId, principalId }, force: true }); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw errors[0];
  }
  return { open, withSession, list, closeSession, prune, initialize, closeAll, validateBrowserUrl,
    get activeSessions() { return sessions.size; } };
}
