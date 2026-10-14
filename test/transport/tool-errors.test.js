import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { AgentError, ErrorCode, normalizeToolError, publicToolError } from '../../src/core/errors.js';
import { createDispatcher } from '../../src/core/dispatcher.js';
import { createCloudAgent } from '../../src/transport/cloud.js';
import { errorResult } from '../../src/transport/mcp/response.js';
import { createRuntime } from '../../src/core/runtime.js';
import { normalizePolicy } from '../../src/permissions/policy.js';

function waitFor(predicate, limit = 2500) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function poll() {
      const found = predicate();
      if (found) return resolve(found);
      if (Date.now() - start > limit) return reject(new Error('Timed out waiting for tool error.'));
      setTimeout(poll, 5);
    }
    poll();
  });
}

test('typed legacy Cache and Browser errors keep codes through dispatcher', async () => {
  const seen = [];
  const dispatch = createDispatcher({ services: {
    list_cached_assets: async () => { throw Object.assign(new Error('Cache missing'), { code: 'CACHE_NOT_FOUND' }); },
    browser_tabs: async () => { throw Object.assign(new Error('Profile locked'), { code: 'BROWSER_PROFILE_IN_USE' }); }
  }, eventBus: { emit(type, value) { seen.push({ type, value }); } } });
  await assert.rejects(dispatch('list_cached_assets'), { code: 'CACHE_NOT_FOUND' });
  await assert.rejects(dispatch('browser_tabs'), { code: 'BROWSER_PROFILE_IN_USE' });
  assert.deepEqual(seen.filter(e => e.type === 'tool.failed').map(e => e.value.error.code),
    ['CACHE_NOT_FOUND', 'BROWSER_PROFILE_IN_USE']);
});

test('tool response safely preserves permission/cancel codes but redacts raw input', () => {
  const secret = 'MY_SECRET_ACCESS_TOKEN_012345';
  for (const code of ['PERMISSION_DENIED', 'CONFIRMATION_REQUIRED', 'REQUEST_CANCELLED',
    'CACHE_NOT_FOUND', 'BROWSER_PROFILE_IN_USE', 'IMAGE_INVALID', 'MEDIA_TIMEOUT']) {
    const error = new AgentError(code, `http://evil.invalid/private/${secret}`, {
      category: 'browserSensitive', toolName: 'browser_fill', secret, path: '/private/credential.json'
    });
    const publicError = publicToolError(error);
    assert.equal(publicError.code, code);
    assert.ok(!JSON.stringify(publicError).includes(secret));
    assert.ok(!JSON.stringify(publicError).includes('/private/'));
    assert.ok(!JSON.stringify(errorResult(error)).includes(secret));
    if (code === 'PERMISSION_DENIED' || code === 'CONFIRMATION_REQUIRED')
      assert.deepEqual(publicError.details, { category: 'browserSensitive', toolName: 'browser_fill' });
    else assert.equal(publicError.details, undefined);
  }
  const internal = normalizeToolError(Object.assign(new Error(`secret=${secret}`), { code: 'ETIMEDOUT' }));
  assert.equal(internal.code, 'INTERNAL_ERROR');
  assert.ok(internal.message.includes(secret), 'internal diagnostics remain available to trusted local callers');
  assert.ok(!JSON.stringify(publicToolError(internal)).includes(secret), 'public error must redact internal diagnostics');
  assert.equal(publicToolError(new Error(`Authorization: Bearer ${secret}`)).code, 'INTERNAL_ERROR');
});

test('Cloud tool.error preserves Image/Cache/Browser denial, confirmation and cancellation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-phase16-tool-errors-'));
  await writeFile(path.join(root, 'sample.png'), 'denied-before-image-decoding');
  const server = new WebSocketServer({ port: 0, path: '/agent' });
  await new Promise(r => server.once('listening', r));
  const address = server.address();
  const messages = [];
  let peer;
  server.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      try { messages.push(JSON.parse(raw.toString())); } catch {}
    });
  });
  const policy = normalizePolicy({ categories: {
    imageRead: 'deny', cacheManage: 'ask', browserNavigate: 'ask', browserExternal: 'deny'
  } });
  const runtime = createRuntime({
    root, policy, interactive: true, instanceId: 'inst_test', principalId: 'test-principal'
  });
  const agent = createCloudAgent({
    cloudUrl: `http://127.0.0.1:${address.port}`,
    credentials: { deviceId: 'device-test', deviceToken: 'DO_NOT_DISCLOSE' },
    runtime, version: '0.4.0', manifest: { count: 29, hash: 'test', manifestVersion: 1 },
    instance: { instanceId: 'inst_test', name: 'fixture', path: root, mode: 'background' },
    deviceInfo: { platform: process.platform, arch: process.arch },
    reconnect: false, heartbeatMs: 60_000
  });
  const send = (requestId, tool, args) => peer.send(JSON.stringify({
    type: 'tool.call', requestId, tool, arguments: args, instanceId: 'inst_test'
  }));
  const errorFor = id => messages.find(m => m.requestId === id && m.type === 'tool.error');
  try {
    agent.connect();
    await waitFor(() => peer && messages.some(m => m.type === 'device.ready'));
    send('denied_image', 'read_image', { path: 'sample.png' });
    assert.equal((await waitFor(() => errorFor('denied_image'))).error.code, 'PERMISSION_DENIED');

    send('ask_cache', 'list_cached_assets', {});
    await waitFor(() => runtime.approvalQueue.getPending().some(p => p.requestId === 'ask_cache'));
    runtime.approvalQueue.resolve(runtime.approvalQueue.getPending()[0].id, { action: 'deny', remember: null });
    assert.equal((await waitFor(() => errorFor('ask_cache'))).error.code, 'PERMISSION_DENIED');

    send('cancel_browser', 'browser_open', { url: 'http://localhost:12345' });
    await waitFor(() => runtime.approvalQueue.getPending().some(p => p.requestId === 'cancel_browser'));
    peer.send(JSON.stringify({ type: 'tool.cancel', instanceId: 'inst_test',
      requestId: 'cancel_browser', reason: 'Cancelled during local approval.' }));
    assert.equal((await waitFor(() => errorFor('cancel_browser'))).error.code, 'REQUEST_CANCELLED');
    assert.equal(runtime.approvalQueue.getPending().length, 0);

    for (const id of ['denied_image', 'ask_cache', 'cancel_browser']) {
      const reported = errorFor(id);
      assert.ok(!JSON.stringify(reported).includes('DO_NOT_DISCLOSE'));
      assert.ok(!JSON.stringify(reported).includes(root));
      assert.ok(reported.error.message.length > 5);
    }
  } finally {
    await agent.stop();
    await runtime.stop();
    await new Promise(r => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
});

test('confirmation-required code persists when interactive approvals are unavailable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-phase16-no-approvals-'));
  const runtime = createRuntime({
    root, interactive: false, policy: normalizePolicy({ categories: { cacheManage: 'ask' } })
  });
  try {
    const failure = await runtime.dispatch('list_cached_assets', {}, { requestId: 'req_unattended' })
      .then(() => null, error => error);
    assert.equal(failure?.code, ErrorCode.CONFIRMATION_REQUIRED);
    assert.equal(publicToolError(failure).code, ErrorCode.CONFIRMATION_REQUIRED);
    assert.equal(errorResult(failure).structuredContent.error.code, ErrorCode.CONFIRMATION_REQUIRED);
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('failed tool audit events preserve actionable code without leaking secret content', async () => {
  const secret = 'DO_NOT_EXPOSE_PRIVATE_CREDENTIAL';
  const history = [];
  const dispatch = createDispatcher({
    services: {
      read_image: async () => {
        throw new AgentError('PERMISSION_DENIED', `blocked ${secret}`, {
          toolName: 'read_image', category: 'imageRead', token: secret
        });
      }
    },
    eventBus: { emit(type, info) { history.push({ type, info }); } }
  });
  await assert.rejects(dispatch('read_image', {}), { code: ErrorCode.PERMISSION_DENIED });
  const failed = history.find(event => event.type === 'tool.failed');
  assert.equal(failed?.info.error.code, ErrorCode.PERMISSION_DENIED);
  assert.deepEqual(failed?.info.error.details, { category: 'imageRead', toolName: 'read_image' });
  assert.equal(JSON.stringify(failed).includes(secret), false);
});

test('Cloud transport keeps CONFIRMATION_REQUIRED and redacts approval context when no prompt is available', async () => {
  const wss = new WebSocketServer({ port: 0, path: '/agent' });
  await new Promise(resolve => wss.once('listening', resolve));
  const messages = [];
  let peer;
  wss.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      try { messages.push(JSON.parse(raw.toString())); } catch {}
    });
  });
  const agent = createCloudAgent({
    cloudUrl: `http://127.0.0.1:${wss.address().port}`,
    credentials: { deviceId: 'test', deviceToken: 'secret' },
    runtime: {
      policyManager: { get: () => ({ categories: {} }) },
      services: { __artifactRequiresCapture: async () => false, __clearCloudImports() {} },
      async dispatch() {
        throw new AgentError(ErrorCode.CONFIRMATION_REQUIRED,
          'Confirmation required: bearer-CANNOT-LEAK', {
            toolName: 'list_cached_assets', category: 'cacheManage',
            fullRequest: 'bearer-CANNOT-LEAK'
          });
      },
      cancel() {}
    },
    manifest: { count: 29, hash: 'test', manifestVersion: 1 },
    version: '0.4.0', reconnect: false, heartbeatMs: 60000,
    instance: { instanceId: 'inst_test', name: 'test', path: '/tmp/test', mode: 'background' },
    deviceInfo: {}
  });
  try {
    agent.connect();
    await waitFor(() => peer && messages.some(m => m.type === 'device.ready'));
    peer.send(JSON.stringify({ type: 'tool.call', instanceId: 'inst_test',
      requestId: 'unattended', tool: 'list_cached_assets', arguments: {} }));
    const reported = await waitFor(() => messages.find(m => m.requestId === 'unattended'));
    assert.equal(reported.type, 'tool.error');
    assert.equal(reported.error.code, ErrorCode.CONFIRMATION_REQUIRED);
    assert.deepEqual(reported.error.details, {
      category: 'cacheManage', toolName: 'list_cached_assets'
    });
    assert.equal(JSON.stringify(reported).includes('CANNOT-LEAK'), false);
  } finally {
    await agent.stop();
    await new Promise(resolve => wss.close(resolve));
  }
});
