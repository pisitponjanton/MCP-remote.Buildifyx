import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import { createArtifactCache } from '../../src/cache/store.js';
import { createRuntime } from '../../src/core/runtime.js';
import { createCloudAgent } from '../../src/transport/cloud.js';
import { normalizePolicy } from '../../src/permissions/policy.js';
import { createPolicyManager } from '../../src/permissions/manager.js';
import { instancePolicyPath, loadInstancePolicy, resetInstancePolicy } from '../../src/permissions/store.js';
import { PERMISSION_CATEGORIES } from '../../src/tui/permission-view.js';
import { applyProfile } from '../../src/tui/profiles.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const chromium = require('playwright').chromium;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 9000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = fn();
    if (value) return value;
    await pause(10);
  }
  throw new Error('Timed out awaiting Cloud Agent or local approval');
}

test('Phase 17: per-instance policies survive reload and base presets cannot elevate 11 advanced permissions', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bdxa-p17-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = 'inst_policy_test_1', second = 'inst_policy_test_2';
  const firstFile = instancePolicyPath(first, dir);
  const initial = await loadInstancePolicy(first, dir);
  assert.deepEqual(Object.keys(initial.categories).sort(), [...PERMISSION_CATEGORIES].sort());
  const manager = createPolicyManager(initial, { filePath: firstFile });
  const overrides = {
    imageRead: 'deny', imageSave: 'ask', cacheManage: 'deny',
    browserRead: 'allow', browserNavigate: 'ask', browserInteract: 'deny',
    persistentProfile: 'deny', browserCapture: 'ask', browserDiagnostics: 'allow',
    browserSensitive: 'deny', browserExternal: 'deny'
  };
  for (const [name, value] of Object.entries(overrides)) await manager.setCategory(name, value);
  for (const preset of ['fullAccess', 'auto', 'readOnly']) {
    await applyProfile(manager, preset);
    for (const [name, value] of Object.entries(overrides))
      assert.equal(manager.get().categories[name], value, name);
  }
  const reloaded = await loadInstancePolicy(first, dir);
  assert.deepEqual(reloaded.categories, manager.get().categories);
  const other = await loadInstancePolicy(second, dir);
  for (const category of PERMISSION_CATEGORIES.slice(5)) assert.equal(other.categories[category], 'ask');
  assert.equal(other.categories.imageRead, 'ask');
  await resetInstancePolicy(first, dir);
  assert.equal((await loadInstancePolicy(first, dir)).categories.browserSensitive, 'ask');
  assert.equal((await loadInstancePolicy(second, dir)).categories.browserSensitive, 'ask');
});

test('Phase 17: Cloud WebSocket Image/Cache/Browser tools respect ASK/ALLOW/DENY, no implicit save', { timeout: 120000 }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'bdxa-p17-cloud-'));
  const root = path.join(base, 'workspace');
  const home = path.join(base, 'home');
  await mkdir(root);
  const bytes = await sharp({ create: { width: 36, height: 24, channels: 3,
    background: { r: 30, g: 110, b: 200 } } }).png().toBuffer();
  await writeFile(path.join(root, 'source.png'), bytes);
  const html = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Phase 17 Browser</title><p>Local safe page</p>');
  });
  await new Promise(r => html.listen(0, '127.0.0.1', r));
  const localUrl = `http://127.0.0.1:${html.address().port}`;
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/agent' });
  await new Promise(r => wss.once('listening', r));
  const wsMessages = [];
  let peer;
  wss.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      try { wsMessages.push(JSON.parse(raw.toString())); } catch {}
    });
  });
  const cache = createArtifactCache({ workspaceRoot: root, homeDirectory: home });
  const policy = normalizePolicy({ categories: {
    imageRead: 'ask', imageSave: 'deny', cacheManage: 'deny',
    browserRead: 'allow', browserNavigate: 'ask', browserCapture: 'ask',
    browserExternal: 'deny', persistentProfile: 'deny', browserSensitive: 'deny'
  } });
  const runtime = createRuntime({ root, imageCache: cache, policy, interactive: true,
    instanceId: 'inst_phase17', principalId: 'phase17-principal', browserOptions: { headless: true } });
  const agent = createCloudAgent({
    cloudUrl: `http://127.0.0.1:${wss.address().port}`,
    credentials: { deviceId: 'mock-device', deviceToken: 'synthetic-device-token-no-login' },
    runtime, version: '0.4.0', manifest: { count: 29, hash: 'test', manifestVersion: 1 },
    instance: { instanceId: 'inst_phase17', name: 'fixture', path: root, mode: 'background' },
    deviceInfo: { platform: process.platform, arch: process.arch }, reconnect: false, heartbeatMs: 60000
  });
  let sequence = 0;
  const send = (tool, args = {}) => {
    const requestId = 'phase17_' + ++sequence;
    peer.send(JSON.stringify({ type: 'tool.call', requestId, tool, arguments: args,
      instanceId: 'inst_phase17' }));
    return { requestId, response: () => wsMessages.find(m => m.requestId === requestId
      && (m.type === 'tool.result' || m.type === 'tool.error')) };
  };
  const pending = id => runtime.approvalQueue.getPending().find(p => p.requestId === id);
  async function decide(call, category, action, remember = null) {
    const request = await waitFor(() => pending(call.requestId));
    assert.equal(request.category, category);
    assert.equal(runtime.approvalQueue.resolve(request.id, { action, remember }), true);
    return waitFor(call.response);
  }
  try {
    agent.connect();
    await waitFor(() => peer && wsMessages.some(m => m.type === 'device.ready'));
    assert.equal(wsMessages.find(m => m.type === 'device.ready').instanceId, 'inst_phase17');

    const firstImage = send('read_image', { path: 'source.png' });
    const firstResult = await decide(firstImage, 'imageRead', 'allow');
    assert.equal(firstResult.type, 'tool.result');
    assert.match(firstResult.result.artifactId, /^art_/);
    assert.equal(firstResult.result.imageBytesDelivered, false);
    assert.equal(runtime.policyManager.get().categories.imageRead, 'ask');
    assert.deepEqual(await readFile(path.join(root, 'source.png')), bytes);

    const secondImage = send('read_image', { path: 'source.png' });
    const imageDenied = await decide(secondImage, 'imageRead', 'deny');
    assert.equal(imageDenied.type, 'tool.error');
    assert.equal(imageDenied.error.code, 'PERMISSION_DENIED');

    await runtime.policyManager.setCategory('imageRead', 'allow');
    const thirdImage = send('read_image', { path: 'source.png' });
    assert.equal((await waitFor(thirdImage.response)).type, 'tool.result');
    assert.equal(pending(thirdImage.requestId), undefined);

    const cacheDenied = send('list_cached_assets');
    assert.equal((await waitFor(cacheDenied.response)).error.code, 'PERMISSION_DENIED');
    await runtime.policyManager.setCategory('cacheManage', 'ask');
    const cacheApproval = send('list_cached_assets');
    const cacheList = await decide(cacheApproval, 'cacheManage', 'allow');
    assert.equal(cacheList.type, 'tool.result');
    assert.ok(cacheList.result.assets.length >= 1);
    assert.equal(runtime.policyManager.get().categories.cacheManage, 'ask');
    await runtime.policyManager.setCategory('cacheManage', 'allow');
    const cacheAllow = send('list_cached_assets');
    assert.equal((await waitFor(cacheAllow.response)).type, 'tool.result');

    const deniedSave = send('save_cached_image', {
      artifactId: firstResult.result.artifactId, destinationPath: 'should-not-exist.png'
    });
    assert.equal((await waitFor(deniedSave.response)).error.code, 'PERMISSION_DENIED');
    assert.equal(existsSync(path.join(root, 'should-not-exist.png')), false);

    // Denied external navigation must not request the external website.
    const deniedExternal = send('browser_open', { url: 'https://example.com/' });
    assert.equal((await waitFor(deniedExternal.response)).error.code, 'PERMISSION_DENIED');

    const blockedPersistent = send('browser_open', {
      url: localUrl, kind: 'persistent', profileName: 'phase17', confirmPersistent: true
    });
    assert.equal((await waitFor(blockedPersistent.response)).error.code, 'PERMISSION_DENIED');
    assert.equal(pending(blockedPersistent.requestId), undefined,
      'persistentProfile DENY must not prompt or silently create a profile');

    const browserDenied = send('browser_open', { url: localUrl });
    assert.equal((await decide(browserDenied, 'browserNavigate', 'deny')).error.code, 'PERMISSION_DENIED');
    let sessionId = null;
    if (existsSync(chromium.executablePath())) {
      const browserAsk = send('browser_open', { url: localUrl });
      const opened = await decide(browserAsk, 'browserNavigate', 'allow');
      assert.equal(opened.type, 'tool.result');
      sessionId = opened.result.sessionId;
      assert.match(sessionId, /^browser_/);
      assert.equal(runtime.policyManager.get().categories.browserNavigate, 'ask');

      await runtime.policyManager.setCategory('browserInteract', 'allow');
      const sensitive = send('browser_click', {
        sessionId, target: { selector: 'p' }, confirmSensitive: true
      });
      assert.equal((await waitFor(sensitive.response)).error.code, 'PERMISSION_DENIED');
      assert.equal(pending(sensitive.requestId), undefined);

      const deniedShot = send('browser_screenshot', { sessionId });
      assert.equal((await decide(deniedShot, 'browserCapture', 'deny')).error.code, 'PERMISSION_DENIED');
      const askedShot = send('browser_screenshot', { sessionId });
      const shot = await decide(askedShot, 'browserCapture', 'allow');
      assert.equal(shot.type, 'tool.result');
      assert.match(shot.result.artifactId, /^art_/);
      assert.equal(shot.result.imageBytesDelivered, false);
      assert.equal(runtime.policyManager.get().categories.browserCapture, 'ask');

      await runtime.policyManager.setCategory('browserCapture', 'deny');
      const blockedShot = send('browser_screenshot', { sessionId });
      assert.equal((await waitFor(blockedShot.response)).error.code, 'PERMISSION_DENIED');
      await runtime.policyManager.setCategory('browserCapture', 'allow');
      const allowedShot = send('browser_screenshot', { sessionId });
      assert.equal((await waitFor(allowedShot.response)).type, 'tool.result');
      assert.equal(pending(allowedShot.requestId), undefined);

      await runtime.policyManager.setCategory('browserNavigate', 'allow');
      const allowedOpen = send('browser_open', { url: localUrl });
      const openedAgain = await waitFor(allowedOpen.response);
      assert.equal(openedAgain.type, 'tool.result');
      assert.equal(pending(allowedOpen.requestId), undefined);
      assert.match(openedAgain.result.sessionId, /^browser_/);
      const closedAgain = send('browser_close', { sessionId: openedAgain.result.sessionId });
      assert.equal((await waitFor(closedAgain.response)).type, 'tool.result');
    } else {
      t.diagnostic('Matching Playwright Chromium is not installed; approved browser screenshot test skipped');
    }
    assert.equal(runtime.policyManager.get().categories.persistentProfile, 'deny');
    assert.equal(runtime.policyManager.get().categories.browserSensitive, 'deny');
    assert.equal(runtime.policyManager.get().categories.imageSave, 'deny');
    assert.deepEqual((await readdir(root)).sort(), ['source.png']);
    assert.deepEqual(await readFile(path.join(root, 'source.png')), bytes);
    assert.equal(runtime.approvalQueue.getPending().length, 0);
    assert.equal(JSON.stringify(wsMessages).includes('synthetic-device-token-no-login'), false,
      'Device bearer token must never be echoed to the Cloud protocol frames');
    assert.equal(wsMessages.filter(m => m.type === 'tool.result').some(m => m.result?.imageBytesDelivered === true), false,
      'non-negotiated Cloud must never claim binary ImageContent reached ChatGPT');
  } finally {
    await agent.stop();
    await runtime.stop();
    cache.close();
    await new Promise(r => wss.close(r));
    await new Promise(r => html.close(r));
    await rm(base, { recursive: true, force: true });
  }
});
