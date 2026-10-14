import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createCloudAgent } from '../../src/transport/cloud.js';
import { digest, MEDIA_CHUNK_BYTES } from '../../src/transport/media/protocol.js';

async function mockCloud(t, { negotiate }) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  t.after(async () => { for (const client of server.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); });
  const data = randomBytes(5 * 1024 * 1024 + 42);
  const toolResult = {
    artifactId: 'art_12345678-1234-1234-1234-123456789abc',
    mimeType: 'image/png', size: data.length, sha256: digest(data), imageBytesDelivered: false
  };
  const frames = [];
  let received = Buffer.alloc(0);
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Cloud tool result timed out')), 15000);
    server.on('connection', (socket, request) => {
      assert.equal(request.headers.authorization, 'Bearer test-token');
      socket.on('message', (bytes) => {
        const m = JSON.parse(bytes.toString());
        frames.push(m);
        assert.ok(bytes.length < 4 * 1024 * 1024);
        if (m.type === 'device.ready') {
          assert.equal(m.protocolVersion, 2);
          assert.equal(m.capabilities.media.version, 1);
          if (negotiate) socket.send(JSON.stringify({
            type: 'media.capabilities.accept', instanceId: 'inst', version: 1,
            features: ['image-content', 'transfer-chunks-v1'], maxChunkBytes: MEDIA_CHUNK_BYTES
          }));
          socket.send(JSON.stringify({ type: 'tool.call', requestId: 'q1', instanceId: 'inst',
            tool: 'get_cached_image', arguments: { artifactId: toolResult.artifactId } }));
        } else if (m.type === 'media.transfer.open') {
          socket.send(JSON.stringify({ type: 'media.transfer.accept', instanceId: 'inst', transferId: m.transferId, requestId: m.requestId, accepted: true }));
        } else if (m.type === 'media.transfer.chunk') {
          assert.equal(m.data.length < 4 * 1024 * 1024, true);
          received = Buffer.concat([received, Buffer.from(m.data, 'base64')]);
          socket.send(JSON.stringify({ type: 'media.transfer.ack', instanceId: 'inst', transferId: m.transferId,
            requestId: m.requestId, index: m.index, offset: m.offset + m.length }));
        } else if (m.type === 'media.transfer.complete') {
          assert.equal(digest(received), m.sha256);
          socket.send(JSON.stringify({ type: 'media.transfer.received', instanceId: 'inst', transferId: m.transferId,
            requestId: m.requestId, size: m.size, sha256: m.sha256 }));
        } else if (m.type === 'tool.result') {
          clearTimeout(timeout);
          resolve(m);
        } else if (m.type === 'tool.error') {
          clearTimeout(timeout);
          reject(new Error(JSON.stringify(m.error)));
        }
      });
    });
  });
  const agent = createCloudAgent({
    cloudUrl: `http://127.0.0.1:${port}`,
    credentials: { deviceId: 'device', deviceToken: 'test-token' },
    runtime: { services: { __readImageBytes: async () => ({ data, metadata: { mimeType: 'image/png' } }),
      __artifactRequiresCapture: async () => false },
      policyManager: { get: () => ({ categories: { imageRead: 'allow', browserCapture: 'allow' } }) },
      dispatch: async () => toolResult, cancel: () => true },
    manifest: { count: 20, hash: 'abc', manifestVersion: 1, tools: [] },
    version: '0.3.3', instance: { instanceId: 'inst', name: 'test', path: '/tmp/workspace', mode: 'foreground' },
    deviceInfo: {}, eventBus: { emit: () => {} }, reconnect: false, heartbeatMs: 60_000
  });
  agent.connect();
  t.after(async () => { await agent.stop(); });
  return { result, frames, data, get received() { return received; } };
}

test('old Cloud continues original JSON-only tool.result and never receives image bytes', async (t) => {
  const cloud = await mockCloud(t, { negotiate: false });
  const answer = await cloud.result;
  assert.equal(answer.result.imageBytesDelivered, false);
  assert.equal(answer.result.mediaTransfer, undefined);
  assert.equal(cloud.frames.some(f => f.type.startsWith('media.transfer')), false);
});

test('capability-confirmed Cloud receives >4 MiB image as acknowledged sub-4-MiB WebSocket frames', async (t) => {
  const cloud = await mockCloud(t, { negotiate: true });
  const answer = await cloud.result;
  assert.equal(answer.result.imageBytesDelivered, false);
  assert.equal(answer.result.mediaTransfer.version, 1);
  assert.ok(cloud.frames.filter(f => f.type === 'media.transfer.chunk').length > 35);
  assert.deepEqual(cloud.received, cloud.data);
});
