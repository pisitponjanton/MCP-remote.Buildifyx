import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createCloudAgent } from '../../src/transport/cloud.js';

function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const value = predicate();
      if (value) { resolve(value); return; }
      if (Date.now() - started >= timeoutMs) { reject(new Error('Timed out waiting for WebSocket message.')); return; }
      setTimeout(check, 10);
    };
    check();
  });
}

test('cloud transport keeps tool calls working while management stays on a separate message path', async () => {
  const wss = new WebSocketServer({ port: 0, path: '/agent' });
  await new Promise((resolve) => wss.once('listening', resolve));
  const address = wss.address();
  assert.ok(address && typeof address === 'object');

  const messages = [];
  let serverSocket = null;
  let afterSendRan = false;
  wss.on('connection', (socket) => {
    serverSocket = socket;
    socket.on('message', (raw) => {
      try { messages.push(JSON.parse(raw.toString())); } catch {}
    });
  });

  const runtime = {
    async dispatch(tool, input) { return { tool, input, ok: true }; },
    cancel() {}
  };
  const agent = createCloudAgent({
    cloudUrl: `http://127.0.0.1:${address.port}`,
    credentials: { deviceId: 'dev_test', deviceToken: 'token_test' },
    runtime,
    manifest: { count: 6, hash: 'hash', manifestVersion: 1 },
    version: '0.3.0',
    instance: { instanceId: 'inst_test', name: 'backend', path: '/tmp/backend', mode: 'background' },
    deviceInfo: { platform: process.platform, arch: process.arch },
    reconnect: false,
    heartbeatMs: 60_000,
    managementCapabilities: ['settings.get', 'instance.restart'],
    async managementHandler(action, args) {
      if (action === 'instance.restart') {
        return {
          result: { accepted: true },
          afterSend: () => { afterSendRan = true; }
        };
      }
      return { action, args };
    }
  });

  try {
    agent.connect();
    const ready = await waitFor(() => messages.find((message) => message.type === 'device.ready'));
    assert.equal(ready.protocolVersion, 2);
    assert.equal(ready.instanceId, 'inst_test');
    assert.deepEqual(ready.capabilities, {
      managementVersion: 1,
      actions: ['settings.get', 'instance.restart']
    });

    serverSocket.send(JSON.stringify({
      type: 'management.call',
      requestId: 'mgmt_settings',
      instanceId: 'inst_test',
      action: 'settings.get',
      arguments: { source: 'web' }
    }));
    const management = await waitFor(() => messages.find((message) => message.requestId === 'mgmt_settings'));
    assert.equal(management.type, 'management.result');
    assert.deepEqual(management.result, { action: 'settings.get', args: { source: 'web' } });

    serverSocket.send(JSON.stringify({
      type: 'tool.call',
      requestId: 'tool_system',
      instanceId: 'inst_test',
      tool: 'get_system_info',
      arguments: {}
    }));
    const tool = await waitFor(() => messages.find((message) => message.requestId === 'tool_system'));
    assert.equal(tool.type, 'tool.result');
    assert.equal(tool.result.tool, 'get_system_info');

    serverSocket.send(JSON.stringify({
      type: 'management.call',
      requestId: 'mgmt_wrong_instance',
      instanceId: 'inst_other',
      action: 'settings.get',
      arguments: {}
    }));
    const mismatch = await waitFor(() => messages.find((message) => message.requestId === 'mgmt_wrong_instance'));
    assert.equal(mismatch.type, 'management.error');
    assert.equal(mismatch.error.code, 'INSTANCE_MISMATCH');

    serverSocket.send(JSON.stringify({
      type: 'management.call',
      requestId: 'mgmt_restart',
      instanceId: 'inst_test',
      action: 'instance.restart',
      arguments: {}
    }));
    const restart = await waitFor(() => messages.find((message) => message.requestId === 'mgmt_restart'));
    assert.equal(restart.type, 'management.result');
    assert.deepEqual(restart.result, { accepted: true });
    await waitFor(() => afterSendRan);
  } finally {
    await agent.stop().catch(() => undefined);
    await new Promise((resolve) => wss.close(resolve));
  }
});
