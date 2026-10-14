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
import { createToolManifest, parseMcpToolInput } from '../../src/transport/mcp/tools/registry.js';

const browserPolicy = normalizePolicy({ categories: {
  browserNavigate: 'allow', browserRead: 'allow', browserInteract: 'allow', persistentProfile: 'deny'
}});
async function fixture(t, policy = browserPolicy, interactive = false) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-browser-control-')));
  const root = path.join(base, 'workspace');
  await mkdir(root);
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/second') return res.end('<title>Second</title><h1>Second page</h1>');
    if (req.url === '/private') return res.end('<title>Private</title><h1>Secret page</h1>');
    return res.end(`<title>Form page</title><h1>Demo</h1><label>Search <input id="search" type="text" /></label><label>Password <input type="password" id="pass" /></label><button type="button" id="update" onclick="document.querySelector('#result').textContent = 'clicked';">Update</button><button type="submit" id="submit">Submit</button><a href="/second" id="same">Same origin</a><a href="https://example.org" id="external">External</a><p id="result">idle</p>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  const runtime = createRuntime({
    root, instanceId: 'inst_browser_test', principalId: 'principal_test', namespace: 'local',
    browserOptions: { homeDirectory: path.join(base, 'state') }, policy, interactive
  });
  t.after(async () => {
    await runtime.stop().catch(() => undefined);
    await new Promise(resolve => server.close(resolve));
    await rm(base, { recursive: true, force: true });
  });
  return { runtime, root, base, url };
}

test('browser tool schemas and manifest enforce bounded selectors, modes and IDs', () => {
  const manifest = createToolManifest();
  const names = ['browser_open','browser_navigate','browser_snapshot','browser_click','browser_fill','browser_tabs','browser_close'];
  for (const name of names) assert.ok(manifest.tools.find(t => t.name === name), name);
  assert.equal(manifest.count, 29);
  assert.deepEqual(parseMcpToolInput('browser_open', {}), { kind: 'temporary' });
  assert.throws(() => parseMcpToolInput('browser_fill', { sessionId: 'x', target: { selector: '#a' }, value: 'secret' }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseMcpToolInput('browser_open', { url: 'a'.repeat(6000) }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseMcpToolInput('browser_click', { sessionId: 'browser_12345678-1234-1234-1234-123456789abc', target: { selector: '#a', text: 'hi' } }), { code: 'INVALID_INPUT' });
});

test('default browser policy requires confirmation', async t => {
  const f = await fixture(t, normalizePolicy(), false);
  await assert.rejects(f.runtime.dispatch('browser_open', { url: f.url }), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(f.runtime.dispatch('browser_fill', { sessionId: 'browser_12345678-1234-1234-1234-123456789abc', target: { selector: '#search' }, value: 'secret-text' }), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(f.runtime.dispatch('browser_open', { kind: 'persistent', profileName: 'test', confirmPersistent: true }), { code: 'CONFIRMATION_REQUIRED' });
});

test('browser_open persistent refuses default denied profile even if navigate allowed', async t => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.dispatch('browser_open', { kind: 'persistent', profileName: 'main', confirmPersistent: true }), { code: 'PERMISSION_DENIED' });
});

test('browser rejects file scheme and protected metadata addresses before launching', async t => {
  const f = await fixture(t);
  for (const url of ['file:///etc/passwd', 'http://169.254.169.254/secret', 'http://192.168.1.1/']) {
    await assert.rejects(f.runtime.dispatch('browser_open', { url }), e => e.code?.startsWith('BROWSER_'));
  }
});

test('Chromium tools open, navigate, snapshot, click, fill, manage tabs and close via dispatcher', { timeout: 60000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Playwright Chromium binary missing');
  const f = await fixture(t);
  const created = await f.runtime.dispatch('browser_open', { url: f.url });
  assert.equal(created.kind, 'temporary');
  assert.equal(created.title, 'Form page');
  const sessionId = created.sessionId;
  const before = await f.runtime.dispatch('browser_snapshot', { sessionId });
  assert.match(before.text, /Demo/);
  assert.equal(before.elements.some(x => x.type === 'password' && 'value' in x), false);
  const filled = await f.runtime.dispatch('browser_fill', { sessionId, target: { selector: '#search' }, value: 'privacy-first' });
  assert.equal(filled.filled, true);
  assert.equal('value' in filled, false);
  await assert.rejects(f.runtime.dispatch('browser_fill', { sessionId, target: { selector: '#pass' }, value: 'secret' }), { code: 'BROWSER_SENSITIVE_ACTION' });
  const clicked = await f.runtime.dispatch('browser_click', { sessionId, target: { selector: '#update' } });
  assert.equal(clicked.clicked, true);
  assert.match((await f.runtime.dispatch('browser_snapshot', { sessionId })).text, /clicked/);
  await assert.rejects(f.runtime.dispatch('browser_click', { sessionId, target: { selector: '#submit' } }), { code: 'BROWSER_SENSITIVE_ACTION' });
  await assert.rejects(f.runtime.dispatch('browser_click', { sessionId, target: { selector: '#external' } }), { code: 'BROWSER_SENSITIVE_ACTION' });
  const tabs = await f.runtime.dispatch('browser_tabs', { sessionId });
  assert.equal(tabs.tabs.length, 1);
  const opened = await f.runtime.dispatch('browser_tabs', { sessionId, action: 'new' });
  assert.equal(opened.tabs.length, 2);
  const second = await f.runtime.dispatch('browser_navigate', { sessionId, tabId: opened.activeTabId, url: f.url + 'second' });
  assert.equal(second.title, 'Second');
  await f.runtime.dispatch('browser_tabs', { sessionId, action: 'close', tabId: opened.activeTabId });
  assert.equal((await f.runtime.dispatch('browser_tabs', { sessionId })).tabs.length, 1);
  assert.deepEqual(await f.runtime.dispatch('browser_close', { sessionId }), { closed: true });
  assert.deepEqual(await f.runtime.dispatch('browser_close', { sessionId }), { closed: false });
});

test('browser_fill audit event does not contain user-entered value', { timeout: 60000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium missing');
  const f = await fixture(t);
  const details = [];
  f.runtime.eventBus.on?.('tool.started', x => details.push(x));
  const session = await f.runtime.dispatch('browser_open', { url: f.url });
  await f.runtime.dispatch('browser_fill', { sessionId: session.sessionId, target: { selector: '#search' }, value: 'private-credential-like-data' });
  assert.doesNotMatch(JSON.stringify(details), /private-credential-like-data/);
});
test('browser network guard rejects DNS answers pointing at private or metadata addresses', async () => {
  const { authorizeBrowserUrl } = await import('../../src/browser/network.js');
  await assert.rejects(authorizeBrowserUrl('https://example.org/', { resolve: async () => [{ address: '169.254.169.254' }] }), { code: 'BROWSER_URL_DENIED' });
  await assert.rejects(authorizeBrowserUrl('https://example.org/', { resolve: async () => [{ address: '93.184.216.34' }, { address: '10.0.0.2' }] }), { code: 'BROWSER_URL_DENIED' });
  assert.equal(await authorizeBrowserUrl('https://example.org/', { resolve: async () => [{ address: '93.184.216.34' }] }), 'https://example.org/');
});

test('simultaneous browser opens reserve a session slot before awaiting Chromium', async () => {
  const { createBrowserControlServices } = await import('../../src/services/browser.js');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const service = createBrowserControlServices({
    instanceId: 'inst_concurrent', principalId: 'principal_concurrent',
    createEngine: () => ({ open: async () => { await gate; throw new Error('test-launch-aborted'); }, closeAll: async () => {} })
  });
  const first = service.browser_open({});
  const second = service.browser_open({});
  const third = service.browser_open({});
  const fourth = service.browser_open({});
  await assert.rejects(fourth, { code: 'BROWSER_SESSION_LIMIT' });
  release();
  await Promise.all([assert.rejects(first), assert.rejects(second), assert.rejects(third)]);
  await service.closeAll();
});

test('new or closed tabs require interaction permission even if browserRead is allowed', async t => {
  const f = await fixture(t, normalizePolicy({ categories: { browserRead: 'allow', browserInteract: 'deny' } }));
  const sessionId = 'browser_12345678-1234-1234-1234-123456789abc';
  await assert.rejects(f.runtime.dispatch('browser_tabs', { sessionId, action: 'new' }), { code: 'PERMISSION_DENIED' });
  await assert.rejects(f.runtime.dispatch('browser_tabs', { sessionId, action: 'close' }), { code: 'PERMISSION_DENIED' });
  await assert.rejects(f.runtime.dispatch('browser_tabs', { sessionId, action: 'list' }), { code: 'BROWSER_SESSION_NOT_FOUND' });
});