import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createRuntime } from '../../src/core/runtime.js';
import { normalizePolicy } from '../../src/permissions/policy.js';
import { createCloudAgent } from '../../src/transport/cloud.js';

async function waitFor(predicate, timeoutMs = 2500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const match = predicate();
    if (match) return match;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for Cloud test condition.');
}

test('duplicate tool.call request IDs fail closed and cannot orphan a pending approval on disconnect', { timeout: 12000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-p18-duplicate-'));
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/agent' });
  await new Promise(resolve => wss.once('listening', resolve));
  const messages = [];
  let peer;
  let closeCode;
  wss.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      try { messages.push(JSON.parse(raw.toString())); } catch {}
    });
    socket.on('close', code => { closeCode = code; });
  });
  const runtime = createRuntime({
    root, instanceId: 'inst_p18', principalId: 'test', interactive: true,
    policy: normalizePolicy({ categories: { cacheManage: 'ask' } })
  });
  const cancelled = [];
  const baseCancel = runtime.cancel.bind(runtime);
  runtime.cancel = (...args) => { cancelled.push(args[0]); return baseCancel(...args); };
  const agent = createCloudAgent({
    cloudUrl: `http://127.0.0.1:${wss.address().port}`,
    credentials: { deviceId: 'dev-p18', deviceToken: 'synthetic-non-production' },
    runtime, manifest: { count: 29, hash: 'fixture', manifestVersion: 1 },
    version: '0.4.0', instance: { instanceId: 'inst_p18', name: 'fixture', path: root, mode: 'background' },
    deviceInfo: {}, reconnect: false, heartbeatMs: 60_000
  });
  t.after(async () => {
    peer?.terminate();
    await agent.stop().catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    await new Promise(resolve => wss.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  agent.connect();
  await waitFor(() => peer && messages.some(message => message.type === 'device.ready'));

  const request = { type: 'tool.call', instanceId: 'inst_p18', requestId: 'duplicate-id',
    tool: 'list_cached_assets', arguments: {} };
  peer.send(JSON.stringify(request));
  await waitFor(() => runtime.approvalQueue.getPending().some(approval => approval.requestId === request.requestId));
  assert.equal(runtime.approvalQueue.getPending().length, 1);

  peer.send(JSON.stringify(request));
  await waitFor(() => closeCode !== undefined);
  assert.equal(closeCode, 1008, 'duplicate in-flight ID is a protocol violation');
  await waitFor(() => runtime.approvalQueue.getPending().length === 0);
  assert.deepEqual(cancelled, ['duplicate-id'], 'original in-flight request must be cancelled on disconnect');
  assert.equal(messages.filter(message => message.requestId === request.requestId
    && (message.type === 'tool.error' || message.type === 'tool.result')).length, 0,
  'a duplicate tool.error must not be misattributed to the original request');
});

test('multiple distinct in-flight calls are all cancelled when Cloud disconnects', { timeout: 12000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-p18-multi-'));
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/agent' });
  await new Promise(resolve => wss.once('listening', resolve));
  let peer;
  let ready = false;
  wss.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => {
      try { if (JSON.parse(raw.toString()).type === 'device.ready') ready = true; } catch {}
    });
  });
  const runtime = createRuntime({
    root, instanceId: 'inst_p18', principalId: 'test', interactive: true,
    policy: normalizePolicy({ categories: { cacheManage: 'ask' } })
  });
  const cancelled = [];
  const baseCancel = runtime.cancel.bind(runtime);
  runtime.cancel = (...args) => { cancelled.push(args[0]); return baseCancel(...args); };
  const agent = createCloudAgent({
    cloudUrl: `http://127.0.0.1:${wss.address().port}`,
    credentials: { deviceId: 'dev-p18', deviceToken: 'synthetic-non-production' },
    runtime, manifest: { count: 29, hash: 'fixture', manifestVersion: 1 },
    version: '0.4.0', instance: { instanceId: 'inst_p18', name: 'fixture', path: root, mode: 'background' },
    deviceInfo: {}, reconnect: false, heartbeatMs: 60_000
  });
  t.after(async () => {
    peer?.terminate();
    await agent.stop().catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    await new Promise(resolve => wss.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  agent.connect();
  await waitFor(() => ready);
  for (const requestId of ['request-a', 'request-b']) {
    peer.send(JSON.stringify({ type: 'tool.call', requestId, tool: 'list_cached_assets',
      arguments: {}, instanceId: 'inst_p18' }));
  }
  await waitFor(() => runtime.approvalQueue.getPending().length === 2);
  peer.close();
  await waitFor(() => runtime.approvalQueue.getPending().length === 0);
  assert.deepEqual(cancelled.sort(), ['request-a', 'request-b']);
});
