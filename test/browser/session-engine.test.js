import assert from 'node:assert/strict';
import { mkdtemp, mkdir, lstat, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBrowserSessionEngine, validateBrowserUrl } from '../../src/browser/session-engine.js';
import { createRuntime } from '../../src/core/runtime.js';
import { createBrowserStorage } from '../../src/browser/storage.js';

const scope = { instanceId: 'inst_test', principalId: 'user_test' };
const secondScope = { instanceId: 'inst_elsewhere', principalId: 'user_test' };
async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-browser-')));
  const homeDirectory = path.join(base, 'state');
  const workspaceRoot = path.join(base, 'workspace');
  const otherRoot = path.join(base, 'other');
  await mkdir(workspaceRoot);
  await mkdir(otherRoot);
  const engines = [];
  t.after(async () => { for (const e of engines) await e.closeAll(); await rm(base, { recursive: true, force: true }); });
  return { base, homeDirectory, workspaceRoot, otherRoot, track: e => { engines.push(e); return e; } };
}
function fakeChromium({ onLaunch, fail = false, wait } = {}) {
  const events = [];
  return {
    events,
    async launchPersistentContext(userDataDir, options) {
      if (wait) await wait();
      if (fail) throw new Error('Chromium unavailable SECRET_PATH=/private');
      onLaunch?.(userDataDir, options);
      const context = {
        closed: false, pages: () => [{ url: () => 'about:blank' }],
        async cookies() { return []; },
        async addCookies() {},
        async close() { context.closed = true; events.push('close:' + userDataDir); }
      };
      events.push('launch:' + userDataDir);
      return context;
    }
  };
}
function engine(f, chromium, overrides = {}) {
  return f.track(createBrowserSessionEngine({
    workspaceRoot: f.workspaceRoot, homeDirectory: f.homeDirectory,
    instanceId: scope.instanceId, principalId: scope.principalId,
    chromium, ...overrides
  }));
}
test('temporary session uses private browser directory and is removed on close without deleting project files', async t => {
  const f = await fixture(t);
  const chromium = fakeChromium();
  const e = engine(f, chromium);
  t.after(() => e.closeAll());
  await writeFile(path.join(f.workspaceRoot, 'keep.txt'), 'important user data');
  const session = await e.open({ scope });
  assert.match(session.sessionId, /^browser_/);
  assert.equal(session.kind, 'temporary');
  assert.equal(session.pageCount, 1);
  assert.equal(chromium.events.length, 1);
  const tempDir = path.dirname(chromium.events[0].slice('launch:'.length));
  assert.match(tempDir, /[\\/]browser[\\/]v1[\\/]sessions[\\/]owner_[a-f0-9]{64}[\\/]bs_[0-9a-f-]+$/);
  assert.equal((await lstat(tempDir)).isDirectory(), true);
  if (process.platform !== 'win32') assert.equal((await lstat(tempDir)).mode & 0o777, 0o700);
  assert.equal(await e.withSession(session.sessionId, ({ pages }) => pages.length, { scope }), 1);
  assert.equal(await e.closeSession(session.sessionId, { scope }), true);
  await assert.rejects(lstat(tempDir), { code: 'ENOENT' });
  assert.equal(await e.closeSession(session.sessionId, { scope }), false);
  assert.equal((await readFile(path.join(f.workspaceRoot, 'keep.txt'), 'utf8')), 'important user data');
});
test('sessions fence principal/instance and cross-workspace manager even with guessed session ID', async t => {
  const f = await fixture(t);
  const a = engine(f, fakeChromium());
  const b = f.track(createBrowserSessionEngine({
    workspaceRoot: f.otherRoot, homeDirectory: f.homeDirectory,
    chromium: fakeChromium(), instanceId: scope.instanceId, principalId: scope.principalId
  }));
  t.after(async () => { await a.closeAll(); await b.closeAll(); });
  const session = await a.open({ scope });
  await assert.rejects(a.withSession(session.sessionId, () => true, { scope: secondScope }), { code: 'BROWSER_ACCESS_DENIED' });
  await assert.rejects(a.closeSession(session.sessionId, { scope: { instanceId: scope.instanceId, principalId: 'intruder' } }), { code: 'BROWSER_ACCESS_DENIED' });
  await assert.rejects(b.withSession(session.sessionId, () => true, { scope }), { code: 'BROWSER_SESSION_NOT_FOUND' });
  await assert.rejects(a.withSession('../other', () => true, { scope }), { code: 'BROWSER_INVALID_SESSION' });
});
test('persistent profile is opt-in and persists only beneath hashed workspace-scoped profile directory', async t => {
  const f = await fixture(t);
  const chromium = fakeChromium();
  const approvals = [];
  const e = engine(f, chromium, { persistentConsent: async data => {
    approvals.push(data.profileName); return data.profileName === 'testing';
  } });
  t.after(() => e.closeAll());
  await assert.rejects(e.open({ scope, kind: 'persistent', profileName: 'testing' }), { code: 'BROWSER_CONSENT_REQUIRED' });
  await assert.rejects(e.open({ scope, kind: 'persistent', profileName: 'refused', confirmPersistent: true }), { code: 'BROWSER_CONSENT_REQUIRED' });
  const session = await e.open({ scope, kind: 'persistent', profileName: 'testing', confirmPersistent: true });
  assert.deepEqual(approvals, ['refused', 'testing']);
  assert.equal(session.kind, 'persistent');
  const dir = chromium.events[0].slice('launch:'.length);
  assert.match(dir, /[\\/]browser[\\/]v1[\\/]profiles[\\/]owner_[a-f0-9]{64}[\\/]profile_[0-9a-f]{64}[\\/]chromium$/);
  await writeFile(path.join(dir, 'persisted-cookie-database'), 'stay-local');
  await e.closeSession(session.sessionId, { scope });
  assert.equal((await readFile(path.join(dir, 'persisted-cookie-database'), 'utf8')), 'stay-local');
  const reused = await e.open({ scope, kind: 'persistent', profileName: 'testing', confirmPersistent: true });
  assert.equal(chromium.events[2], 'launch:' + dir);
  assert.notEqual(reused.sessionId, session.sessionId);
});
test('profile lock denies concurrent engines and recovers only dead PID lock', async t => {
  const f = await fixture(t);
  const a = engine(f, fakeChromium(), { persistentConsent: async () => true });
  const b = engine(f, fakeChromium(), { persistentConsent: async () => true });
  t.after(async () => { await a.closeAll(); await b.closeAll(); });
  const opened = await a.open({ scope, kind: 'persistent', profileName: 'shared', confirmPersistent: true });
  await assert.rejects(b.open({ scope, kind: 'persistent', profileName: 'shared', confirmPersistent: true }), { code: 'BROWSER_PROFILE_IN_USE' });
  await a.closeSession(opened.sessionId, { scope });
  const next = await b.open({ scope, kind: 'persistent', profileName: 'shared', confirmPersistent: true });
  assert.ok(next.sessionId);
});
test('session quotas, reaping idle sessions and active operation fencing', async t => {
  const f = await fixture(t);
  let clock = 1000;
  const e = engine(f, fakeChromium(), { now: () => clock, idleMs: 50, maxSessions: 1, sweepMs: 10_000 });
  t.after(() => e.closeAll());
  const s = await e.open({ scope });
  await assert.rejects(e.open({ scope }), { code: 'BROWSER_SESSION_LIMIT' });
  await e.withSession(s.sessionId, async () => {
    clock += 60;
    assert.deepEqual(await e.prune(), { closed: 0 });
    await assert.rejects(e.closeSession(s.sessionId, { scope }), { code: 'BROWSER_IN_USE' });
  }, { scope });
  clock += 51;
  assert.deepEqual(await e.prune(), { closed: 1 });
  await assert.rejects(e.withSession(s.sessionId, () => true, { scope }), { code: 'BROWSER_SESSION_NOT_FOUND' });
  assert.equal((await e.list({ scope })).length, 0);
});
test('parallel opens reserve slots before launching Chromium', async t => {
  const f = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const e = engine(f, fakeChromium({ wait: () => gate }), { maxSessions: 1 });
  t.after(() => e.closeAll());
  const first = e.open({ scope });
  while (e.activeSessions === 0 && !(await readdir(path.join(f.homeDirectory, 'browser', 'v1', 'sessions')).catch(() => [])).length) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await assert.rejects(e.open({ scope }), { code: 'BROWSER_SESSION_LIMIT' });
  release();
  const s = await first;
  assert.equal(e.activeSessions, 1);
  assert.equal(s.kind, 'temporary');
});
test('failed browser launch cleans up temp only, never creates persistent profile implicitly', async t => {
  const f = await fixture(t);
  const e = engine(f, fakeChromium({ fail: true }));
  t.after(() => e.closeAll());
  await assert.rejects(e.open({ scope }), { code: 'BROWSER_LAUNCH_FAILED' });
  const store = createBrowserStorage({ workspaceRoot: f.workspaceRoot, homeDirectory: f.homeDirectory });
  const state = await store.init();
  assert.deepEqual(await readdir(state.sessions), []);
  assert.deepEqual(await readdir(state.profiles), []);
});
test('startup cleanup removes only dead-process temporary sessions, not other workspaces or persistent profile files', async t => {
  const f = await fixture(t);
  const store = createBrowserStorage({ workspaceRoot: f.workspaceRoot, homeDirectory: f.homeDirectory });
  const temp = await store.createTemporary();
  const metaFile = path.join(temp.directory, 'session.json');
  const record = JSON.parse(await readFile(metaFile, 'utf8'));
  record.pid = 99999999;
  await writeFile(metaFile, JSON.stringify(record));
  const otherStore = createBrowserStorage({ workspaceRoot: f.otherRoot, homeDirectory: f.homeDirectory });
  const other = await otherStore.createTemporary();
  const profile = await store.profileDirectory('saved');
  await writeFile(path.join(profile.dataDirectory, 'login-state'), 'must-keep');
  assert.deepEqual(await store.cleanupOrphans(), { removed: 1 });
  await assert.rejects(lstat(temp.directory), { code: 'ENOENT' });
  assert.equal((await lstat(other.directory)).isDirectory(), true);
  assert.equal((await readFile(path.join(profile.dataDirectory, 'login-state'), 'utf8')), 'must-keep');
  await otherStore.removeTemporary(other.id);
});
test('unsafe session metadata and symlink directories fail closed without removing external paths', async t => {
  const f = await fixture(t);
  const store = createBrowserStorage({ workspaceRoot: f.workspaceRoot, homeDirectory: f.homeDirectory });
  const temp = await store.createTemporary();
  await writeFile(path.join(temp.directory, 'session.json'), JSON.stringify({ version: 1, id: temp.id, ownerKey: 'other-owner', pid: 1 }));
  await assert.rejects(store.removeTemporary(temp.id), { code: 'BROWSER_INVALID_STATE' });
  const outside = path.join(f.workspaceRoot, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'keep.txt'), 'survive');
  await rm(temp.directory, { recursive: true });
  await symlink(outside, temp.directory);
  await assert.rejects(store.removeTemporary(temp.id), /Unsafe|linked/);
  assert.equal((await readFile(path.join(outside, 'keep.txt'), 'utf8')), 'survive');
});
test('URL validation supports localhost but rejects file/data/private targets and credentials', () => {
  assert.equal(validateBrowserUrl('http://localhost:3000/test'), 'http://localhost:3000/test');
  assert.equal(validateBrowserUrl('http://127.0.0.1:5000'), 'http://127.0.0.1:5000/');
  assert.equal(validateBrowserUrl('https://example.org/path'), 'https://example.org/path');
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hello', 'http://name:password@example.org',
    'http://169.254.169.254/latest/meta-data', 'http://192.168.1.1', 'http://10.0.0.1']) {
    assert.throws(() => validateBrowserUrl(url), /Browser URL|Only HTTP|Private-network/);
  }
});


test('different principals sharing one workspace never reuse browser profiles or temporary directories', async t => {
  const f = await fixture(t);
  const alice = createBrowserStorage({ workspaceRoot: f.workspaceRoot, homeDirectory: f.homeDirectory, principalId: 'alice' });
  const bob = createBrowserStorage({ workspaceRoot: f.workspaceRoot, homeDirectory: f.homeDirectory, principalId: 'bob' });
  const aliceState = await alice.init();
  const bobState = await bob.init();
  assert.notEqual(aliceState.profiles, bobState.profiles);
  assert.notEqual(aliceState.sessions, bobState.sessions);
  const a = await alice.profileDirectory('same-name');
  const b = await bob.profileDirectory('same-name');
  assert.notEqual(a.dataDirectory, b.dataDirectory);
  await writeFile(path.join(a.dataDirectory, 'private'), 'alice-only');
  await assert.rejects(readFile(path.join(b.dataDirectory, 'private')), { code: 'ENOENT' });
});
test('persistent profile state snapshot is private and rejects symlink replacement', async t => {
  const f = await fixture(t);
  const store = createBrowserStorage({ workspaceRoot: f.workspaceRoot, homeDirectory: f.homeDirectory });
  await store.saveProfileState('secure', [{ name: 'a', value: 'secret', domain: 'example.org', path: '/', expires: 2000000000 }]);
  assert.equal((await store.readProfileState('secure'))[0].value, 'secret');
  const profile = await store.profileDirectory('secure');
  const snapshot = path.join(profile.directory, 'browser-state.json');
  if (process.platform !== 'win32') assert.equal((await lstat(snapshot)).mode & 0o777, 0o600);
  const outside = path.join(f.workspaceRoot, 'outside.txt');
  await writeFile(outside, 'do-not-modify');
  await rm(snapshot);
  await symlink(outside, snapshot);
  await assert.rejects(store.readProfileState('secure'), { code: 'BROWSER_UNSAFE_PATH' });
  await assert.rejects(store.saveProfileState('secure', []), { code: 'BROWSER_UNSAFE_PATH' });
  assert.equal(await readFile(outside, 'utf8'), 'do-not-modify');
});
test('stale profile lock can be recovered after a crashed process, while live locks are retained', async t => {
  const f = await fixture(t);
  const store = createBrowserStorage({ workspaceRoot: f.workspaceRoot, homeDirectory: f.homeDirectory });
  const release = await store.acquireProfileLock('recovery');
  const profile = await store.profileDirectory('recovery');
  const lockDir = path.join(path.dirname(profile.directory), profile.key + '.lock');
  const ownerFile = path.join(lockDir, 'owner.json');
  const record = JSON.parse(await readFile(ownerFile, 'utf8'));
  await writeFile(ownerFile, JSON.stringify({ ...record, pid: 99999999 }));
  const recovered = await store.acquireProfileLock('recovery');
  await assert.rejects(store.acquireProfileLock('recovery'), { code: 'BROWSER_PROFILE_IN_USE' });
  await assert.rejects(release(), { code: 'BROWSER_PROFILE_IN_USE' });
  await recovered();
});

test('Agent runtime creates browser engines only for explicit internal owners and closes them on shutdown', async t => {
  const f = await fixture(t);
  const runtime = createRuntime({ root: f.workspaceRoot, namespace: 'local', interactive: false });
  const browser = runtime.createBrowserEngine({
    instanceId: scope.instanceId, principalId: scope.principalId,
    homeDirectory: f.homeDirectory, chromium: fakeChromium()
  });
  const running = await browser.open({ scope });
  assert.equal(browser.activeSessions, 1);
  await assert.rejects(runtime.dispatch('browser_open', {}), { code: 'TOOL_NOT_FOUND' });
  await runtime.stop();
  assert.equal(browser.activeSessions, 0);
  await assert.rejects(browser.withSession(running.sessionId, () => true, { scope }), { code: 'BROWSER_SESSION_NOT_FOUND' });
  assert.throws(() => runtime.createBrowserEngine({ instanceId: 'next', principalId: 'next' }), { code: 'REQUEST_CANCELLED' });
});
