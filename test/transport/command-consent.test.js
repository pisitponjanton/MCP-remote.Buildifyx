import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createRuntime } from '../../src/core/runtime.js';
import { createCloudAgent } from '../../src/transport/cloud.js';
import { normalizePolicy } from '../../src/permissions/policy.js';

async function waitFor(predicate) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const found = predicate();
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Cloud command fixture timed out');
}

test('real Agent WebSocket transport preserves exact command approvals and hard-denial diagnostics', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-cloud-command-')));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/agent' });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const messages = [];
  let peer;
  server.on('connection', socket => {
    peer = socket;
    socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
  });
  const runtime = createRuntime({ root, interactive: true,
    policy: normalizePolicy({ categories: { write: 'deny', outsideRoot: 'deny' } }) });
  const agent = createCloudAgent({
    cloudUrl: `http://127.0.0.1:${server.address().port}`,
    credentials: { deviceId: 'permission-fixture', deviceToken: 'fixture-token' }, runtime,
    version: '0.4.0', manifest: { count: 35, hash: 'fixture', manifestVersion: 1 },
    instance: { instanceId: 'inst_permission', name: 'permission-fixture', path: root, mode: 'background' },
    deviceInfo: { platform: process.platform, arch: process.arch }, reconnect: false, heartbeatMs: 60000
  });
  const send = (requestId, args) => peer.send(JSON.stringify({ type: 'tool.call', requestId,
    tool: 'run_command', arguments: args, instanceId: 'inst_permission' }));
  const response = id => messages.find(item => item.requestId === id && ['tool.result', 'tool.error'].includes(item.type));
  try {
    agent.connect();
    await waitFor(() => peer && messages.some(item => item.type === 'device.ready'));
    send('query', { command: 'git', args: ['--version'] });
    assert.equal((await waitFor(() => response('query'))).result.exitCode, 0);
    assert.equal(runtime.approvalQueue.getPending().length, 0);

    send('approve', { command: 'node', args: ['--version'] });
    const approval = await waitFor(() => runtime.approvalQueue.getPending()[0]);
    assert.equal(approval.evaluation.operationClass, 'unclassified');
    runtime.approvalQueue.resolve(approval.id, { action: 'allow', remember: 'command' });
    assert.equal((await waitFor(() => response('approve'))).result.exitCode, 0);
    assert.equal(runtime.policyManager.get().commandRules[0].cwd, root);
    assert.equal(runtime.policyManager.get().commandRules[0].exact, true);
    send('remembered', { command: 'node', args: ['--version'] });
    assert.equal((await waitFor(() => response('remembered'))).result.exitCode, 0);
    assert.equal(runtime.approvalQueue.getPending().length, 0);

    await runtime.policyManager.setCategory('command', 'deny');
    send('denied', { command: 'node', args: ['--version'] });
    const rejected = await waitFor(() => response('denied'));
    assert.equal(rejected.error.code, 'PERMISSION_DENIED');
    assert.equal(rejected.error.details.category, 'command');
    assert.equal(rejected.error.details.nextAction, 'reviewLocalPolicy');
    assert.equal(JSON.stringify(rejected).includes(root), false);
    assert.equal(JSON.stringify(rejected).includes('fixture-token'), false);
  } finally {
    await agent.stop(); await runtime.stop();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
