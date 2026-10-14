import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { createRuntime } from '../../src/core/runtime.js';
import { normalizePolicy } from '../../src/permissions/policy.js';

async function fixture(t, categories = {}, interactive = false) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-browser-privacy-')));
  const root = path.join(base, 'workspace');
  await mkdir(root);
  let remoteHits = 0;
  const remote = createServer((req, res) => {
    remoteHits++;
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Other origin</title><h1>Other origin reached</h1>');
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const other = 'http://127.0.0.1:' + remote.address().port;
  let posts = 0;
  const site = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/redirect') { res.writeHead(302, { location: other + '/secret' }); return res.end(); }
    if (req.url === '/submit') { posts++; return res.end('<title>Submitted</title>'); }
    res.end('<title>Privacy fixture</title><h1>Privacy test</h1>' +
      '<form action="/submit" method="post"><input type="text" name="message" id="text"><input type="password" id="password"><button id="submit" type="submit">Submit</button></form>' +
      '<a id="redirect" href="/redirect">Go redirect</a>' +
      '<a id="cross" href="' + other + '/secret">Go cross</a>' +
      '<button id="popup" onclick="window.open(' + "'" + other + "/secret','_blank'" + ')">Popup</button>' +
      '<p>api_key=SECRET_TEST_VALUE bearer SECRET_TEST_VALUE</p>');
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const runtime = createRuntime({
    root, instanceId: 'inst_privacy', principalId: 'principal_privacy', namespace: 'local',
    browserOptions: { homeDirectory: path.join(base, 'state') },
    policy: normalizePolicy({ categories: { browserNavigate: 'allow', browserRead: 'allow',
      browserInteract: 'allow', browserCapture: 'allow', browserDiagnostics: 'allow',
      browserExternal: 'ask', browserSensitive: 'ask', ...categories } }),
    interactive
  });
  t.after(async () => {
    await runtime.stop().catch(() => undefined);
    await new Promise(resolve => site.close(resolve));
    await new Promise(resolve => remote.close(resolve));
    await rm(base, { recursive: true, force: true });
  });
  return { runtime, root, base, url: 'http://127.0.0.1:' + site.address().port + '/', other, get posts() { return posts; }, get remoteHits() { return remoteHits; } };
}

async function answerApproval(runtime, category) {
  let entry;
  for (let i = 0; i < 150; i++) {
    entry = runtime.approvalQueue.getPending().find(e => e.category === category);
    if (entry) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(entry?.category, category);
  assert.equal(runtime.approvalQueue.resolve(entry.id, { action: 'allow', remember: null }), true);
  return entry;
}

test('no sensitive action executes without a separate approval and no password or target reaches audit', { timeout: 60000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium missing');
  const f = await fixture(t, {}, true);
  const events = [];
  f.runtime.eventBus.subscribe(entry => { if (entry.type === 'tool.started' || entry.type === 'permission.requested') events.push(entry); });
  const opened = await f.runtime.dispatch('browser_open', { url: f.url });
  const a = { sessionId: opened.sessionId, target: { selector: '#submit' } };
  await assert.rejects(f.runtime.dispatch('browser_click', a), { code: 'BROWSER_SENSITIVE_ACTION' });
  assert.equal(f.posts, 0);
  const dispatched = f.runtime.dispatch('browser_click', { ...a, confirmSensitive: true });
  const pending = await answerApproval(f.runtime, 'browserSensitive');
  assert.deepEqual(pending.input.target, '[redacted target]');
  const clicked = await dispatched;
  assert.equal(clicked.clicked, true);
  assert.equal(f.posts, 1);
  const fresh = await f.runtime.dispatch('browser_navigate', { sessionId: opened.sessionId, url: f.url });
  const password = f.runtime.dispatch('browser_fill', { sessionId: opened.sessionId,
    target: { selector: '#password' }, value: 'SENSITIVE_PASSWORD_VALUE', confirmSensitive: true });
  const prompt = await answerApproval(f.runtime, 'browserSensitive');
  assert.equal(prompt.input.value, '<redacted>');
  assert.equal((await password).filled, true);
  assert.doesNotMatch(JSON.stringify(events), /SENSITIVE_PASSWORD_VALUE|#password/);
  assert.equal(fresh.title, 'Privacy fixture');
});

test('origin firewall blocks unapproved redirects and popups, even to another localhost port', { timeout: 60000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium missing');
  const f = await fixture(t);
  const opened = await f.runtime.dispatch('browser_open', { url: f.url });
  await assert.rejects(f.runtime.dispatch('browser_navigate', { sessionId: opened.sessionId, url: f.url + 'redirect' }), { code: 'BROWSER_NAVIGATION_FAILED' });
  const replacement = await f.runtime.dispatch('browser_tabs', { sessionId: opened.sessionId, action: 'new' });
  const tabId = replacement.activeTabId;
  await f.runtime.dispatch('browser_navigate', { sessionId: opened.sessionId, tabId, url: f.url });
  const snapshot = await f.runtime.dispatch('browser_snapshot', { sessionId: opened.sessionId, tabId });
  assert.doesNotMatch(snapshot.text, /Other origin reached/);
  await f.runtime.dispatch('browser_click', { sessionId: opened.sessionId, tabId, target: { selector: '#popup' } });
  const tabs = await f.runtime.dispatch('browser_tabs', { sessionId: opened.sessionId });
  assert.equal(tabs.tabs.length, 2);
  assert.equal(f.remoteHits, 0, 'No unapproved redirect or popup request may reach the other origin');
  await assert.rejects(f.runtime.dispatch('browser_click', { sessionId: opened.sessionId, tabId, target: { selector: '#cross' } }), { code: 'BROWSER_SENSITIVE_ACTION' });
  const explicit = await f.runtime.dispatch('browser_navigate', { sessionId: opened.sessionId, tabId, url: f.other + '/secret' });
  assert.equal(explicit.title, 'Other origin');
  assert.equal(f.remoteHits, 1);
});

test('policy changes deny active operations and external-origin approval does not leak full URL', { timeout: 60000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium missing');
  const f = await fixture(t, {}, true);
  const opened = await f.runtime.dispatch('browser_open', { url: f.url });
  const audit = [];
  f.runtime.eventBus.subscribe(event => { if (event.type === 'permission.requested') audit.push(event); });
  const dispatch = f.runtime.dispatch('browser_navigate', { sessionId: opened.sessionId, url: 'https://example.org/path?token=NO_LOG_TOKEN' });
  await answerApproval(f.runtime, 'browserExternal');
  await dispatch.catch(error => { assert.ok(error.code?.startsWith('BROWSER_')); });
  assert.doesNotMatch(JSON.stringify(audit), /NO_LOG_TOKEN/);
  await f.runtime.policyManager.setCategory('browserNavigate', 'deny');
  await assert.rejects(f.runtime.dispatch('browser_snapshot', { sessionId: opened.sessionId }),
    e => ['PERMISSION_DENIED', 'BROWSER_SESSION_NOT_FOUND'].includes(e.code));
});

test('cancel request while waiting for sensitive approval makes no change', { timeout: 60000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium missing');
  const f = await fixture(t, {}, true);
  const opened = await f.runtime.dispatch('browser_open', { url: f.url });
  const requestId = 'cancel-sensitive-request';
  const pending = f.runtime.dispatch('browser_click', {
    sessionId: opened.sessionId, target: { selector: '#submit' }, confirmSensitive: true
  }, { requestId });
  let found;
  for (let i = 0; i < 150; i++) {
    found = f.runtime.approvalQueue.getPending().find(x => x.category === 'browserSensitive');
    if (found) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(found);
  assert.equal(f.runtime.cancel(requestId), true);
  await assert.rejects(pending, { code: 'REQUEST_CANCELLED' });
  assert.equal(f.posts, 0);
});


test('persistent browser requires two explicit consent gates and closes on profile permission revocation', { timeout: 60000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium missing');
  const f = await fixture(t, { persistentProfile: 'ask' }, true);
  await assert.rejects(f.runtime.dispatch('browser_open', {
    kind: 'persistent', profileName: 'user-approved'
  }), { code: 'BROWSER_CONSENT_REQUIRED' });
  const promise = f.runtime.dispatch('browser_open', {
    kind: 'persistent', profileName: 'user-approved', confirmPersistent: true, url: f.url
  });
  const pending = await answerApproval(f.runtime, 'persistentProfile');
  assert.equal(pending.input.profileName, 'user-approved');
  const opened = await promise;
  assert.equal(opened.kind, 'persistent');
  await f.runtime.policyManager.setCategory('persistentProfile', 'deny');
  for (let i = 0; i < 100 && f.runtime.services.browser_tabs; i++) {
    try { await f.runtime.dispatch('browser_snapshot', { sessionId: opened.sessionId }); }
    catch (error) {
      if (error.code === 'BROWSER_SESSION_NOT_FOUND') return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Persistent session remained active after profile permission was revoked.');
});
