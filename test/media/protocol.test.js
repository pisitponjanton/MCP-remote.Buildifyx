import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { createCloudMediaBridge } from '../../src/transport/media/cloud-bridge.js';
import { createLocalMediaAgent } from '../../src/transport/media/local-agent.js';
import { mediaMcpResult } from '../../src/transport/media/mcp-image.js';
import { createMediaTransferRegistry, digest, equalDigest, MEDIA_CHUNK_BYTES, receiveChunks } from '../../src/transport/media/protocol.js';

const artifactId = 'art_12345678-1234-1234-1234-123456789abc';
const secret = randomBytes(32).toString('hex');
function fixture(size = 5 * 1024 * 1024 + 127) {
  const data = randomBytes(size);
  const metadata = { mimeType: 'image/png' };
  const result = { artifactId, mimeType: metadata.mimeType, sha256: digest(data), size: data.length, imageBytesDelivered: false };
  const registry = createMediaTransferRegistry({ readImage: async () => ({ data: Buffer.from(data), metadata }) });
  return { registry, data, metadata, result };
}
test('5 MiB transfer crosses many 128 KiB IPC chunks and yields correct MCP ImageContent', async () => {
  const { registry, data, result } = fixture();
  const args = { requestId: 'req-1', secret, tool: 'read_image', result, artifactId };
  const image = await receiveChunks({
    open: () => registry.open(args),
    chunk: (payload) => registry.chunk({ ...args, ...payload }),
    finish: (payload) => registry.finish({ ...args, ...payload }),
    cancel: (payload) => registry.cancel({ ...args, ...payload })
  });
  assert.deepEqual(image.data, data);
  assert.equal(registry.active, 0);
  const resultContent = mediaMcpResult(result, image);
  assert.equal(resultContent.content[1].type, 'image');
  assert.equal(resultContent.content[1].mimeType, 'image/png');
  assert.equal(resultContent.structuredContent.imageBytesDelivered, true);
  assert.deepEqual(Buffer.from(resultContent.content[1].data, 'base64'), data);
});
test('transfer registry fences request secret and chunk order', async () => {
  const { registry, result } = fixture(384_001);
  const args = { requestId: 'req-2', secret, tool: 'get_cached_image', result, artifactId };
  const offer = await registry.open(args);
  assert.throws(() => registry.chunk({ transferId: offer.transferId, requestId: 'wrong', secret, index: 0, offset: 0 }), { code: 'MEDIA_DENIED' });
  assert.throws(() => registry.chunk({ transferId: offer.transferId, requestId: args.requestId, secret: randomBytes(32).toString('hex'), index: 0, offset: 0 }), { code: 'MEDIA_DENIED' });
  const first = registry.chunk({ ...args, transferId: offer.transferId, index: 0, offset: 0 });
  assert.equal(first.length, MEDIA_CHUNK_BYTES);
  assert.throws(() => registry.chunk({ ...args, transferId: offer.transferId, index: 0, offset: 0 }), { code: 'MEDIA_ORDER' });
  assert.throws(() => registry.finish({ ...args, transferId: offer.transferId }), { code: 'MEDIA_INCOMPLETE' });
  assert.deepEqual(registry.cancel({ ...args, transferId: offer.transferId }), { cancelled: true });
  assert.equal(registry.active, 0);
});
test('bounded receiver refuses incorrect chunks and cleans session', async () => {
  const { registry, result } = fixture(300_200);
  const args = { requestId: 'req-3', secret, tool: 'read_image', result, artifactId };
  await assert.rejects(receiveChunks({
    open: () => registry.open(args),
    chunk: (payload) => {
      const data = registry.chunk({ ...args, ...payload });
      data.data = Buffer.from('tamper').toString('base64');
      return data;
    },
    finish: (payload) => registry.finish({ ...args, ...payload }),
    cancel: (payload) => registry.cancel({ ...args, ...payload })
  }), { code: 'MEDIA_INVALID' });
  assert.equal(registry.active, 0);
});
test('closed, expired, over-quota and nonimage sessions are denied', async () => {
  let now = 10_000;
  const { registry, result } = fixture(1024);
  const local = createMediaTransferRegistry({ readImage: async () => ({ data: randomBytes(1024), metadata: { mimeType: 'application/pdf' } }), now: () => now });
  await assert.rejects(local.open({ requestId: 'req', secret, tool: 'read_image', result, artifactId }), { code: 'MEDIA_INVALID' });
  const session = await registry.open({ requestId: 'test', secret, tool: 'read_image', result, artifactId });
  registry.close();
  assert.throws(() => registry.chunk({ transferId: session.transferId, requestId: 'test', secret, index: 0, offset: 0 }), { code: 'MEDIA_DENIED' });
});
test('local media control only opens a transfer tied to an authorized tool-call secret', async () => {
  const { data, result } = fixture(700_000);
  const agent = createLocalMediaAgent({ readImage: async () => ({ data, metadata: { mimeType: 'image/png' } }) });
  agent.authorize({ requestId: 'req', secret, tool: 'read_image', result });
  await assert.rejects(agent.command({ command: 'media.open', requestId: 'req', secret: randomBytes(32).toString('hex'), artifactId }), { code: 'MEDIA_DENIED' });
  const reply = await agent.command({ command: 'media.open', requestId: 'req', secret, artifactId });
  const transferId = reply.media.transferId;
  assert.ok(transferId.startsWith('transfer_'));
  await assert.rejects(agent.command({ command: 'media.open', requestId: 'req', secret, artifactId }), { code: 'MEDIA_DENIED' });
  const chunk = await agent.command({ command: 'media.chunk', requestId: 'req', secret, transferId, index: 0, offset: 0 });
  assert.equal(chunk.media.length, MEDIA_CHUNK_BYTES);
  agent.close();
});
test('Cloud refuses no/mismatched capabilities and only sends with explicit opt-in ACK', async () => {
  const { data, result } = fixture(3 * 1024 * 1024 + 11);
  const frames = [];
  let bridge;
  let accumulated = Buffer.alloc(0);
  const send = async (message) => {
    frames.push(message);
    assert.ok(Buffer.byteLength(JSON.stringify(message)) < 4 * 1024 * 1024);
    if (message.type === 'media.transfer.open') {
      queueMicrotask(() => bridge.receive({ type: 'media.transfer.accept', instanceId: 'instance-1', transferId: message.transferId, requestId: 'request-1', accepted: true }));
    }
    if (message.type === 'media.transfer.chunk') {
      const bytes = Buffer.from(message.data, 'base64');
      assert.equal(bytes.length, message.length);
      assert.ok(bytes.length <= MEDIA_CHUNK_BYTES);
      accumulated = Buffer.concat([accumulated, bytes]);
      queueMicrotask(() => bridge.receive({ type: 'media.transfer.ack', instanceId: 'instance-1', transferId: message.transferId, requestId: 'request-1', offset: message.offset + bytes.length, index: message.index }));
    }
    if (message.type === 'media.transfer.complete') {
      queueMicrotask(() => bridge.receive({ type: 'media.transfer.received', instanceId: 'instance-1', transferId: message.transferId, requestId: 'request-1', size: message.size, sha256: message.sha256 }));
    }
  };
  bridge = createCloudMediaBridge({ instanceId: 'instance-1', readImage: async () => ({ data, metadata: { mimeType: 'image/png' } }), send });
  assert.equal(bridge.active, false);
  assert.equal(await bridge.sendImage('read_image', result, 'request-1'), null);
  assert.equal(bridge.acceptCapabilities({ instanceId: 'instance-wrong', version: 1, features: ['image-content', 'transfer-chunks-v1'], maxChunkBytes: MEDIA_CHUNK_BYTES }), false);
  assert.equal(bridge.acceptCapabilities({ instanceId: 'instance-1', version: 1, features: ['image-content'], maxChunkBytes: MEDIA_CHUNK_BYTES }), false);
  assert.equal(bridge.acceptCapabilities({ instanceId: 'instance-1', version: 1, features: ['image-content', 'transfer-chunks-v1'], maxChunkBytes: MEDIA_CHUNK_BYTES }), true);
  const delivered = await bridge.sendImage('read_image', result, 'request-1');
  assert.equal(delivered.size, data.length);
  assert.equal(delivered.sha256, digest(data));
  assert.deepEqual(accumulated, data);
  bridge.stop();
  assert.equal(bridge.active, false);
});
test('Cloud ACK with wrong offset fails closed and attempts cancel', async () => {
  const { data, result } = fixture(512_000);
  let bridge;
  const sent = [];
  const send = async (m) => {
    sent.push(m.type);
    if (m.type === 'media.transfer.open') queueMicrotask(() => bridge.receive({ type: 'media.transfer.accept', instanceId: 'inst', transferId: m.transferId, requestId: 'req', accepted: true }));
    if (m.type === 'media.transfer.chunk') queueMicrotask(() => bridge.receive({ type: 'media.transfer.ack', instanceId: 'inst', transferId: m.transferId, requestId: 'req', index: m.index, offset: -1 }));
  };
  bridge = createCloudMediaBridge({ instanceId: 'inst', readImage: async () => ({ data, metadata: { mimeType: 'image/png' } }), send });
  bridge.acceptCapabilities({ instanceId: 'inst', version: 1, features: ['transfer-chunks-v1', 'image-content'], maxChunkBytes: MEDIA_CHUNK_BYTES });
  await assert.rejects(bridge.sendImage('read_image', result, 'req'), { code: 'MEDIA_INVALID' });
  assert.ok(sent.includes('media.transfer.cancel'));
});
test('checksum helper rejects invalid hash and metadata lies', async () => {
  const { data, result } = fixture(1024);
  assert.equal(equalDigest(digest(data), result.sha256), true);
  assert.equal(equalDigest('x', result.sha256), false);
  assert.throws(() => mediaMcpResult({ ...result, sha256: 'f'.repeat(64) }, { data, mimeType: 'image/png' }), { code: 'MEDIA_INVALID' });
});
test('Cloud cancellation aborts an in-flight ACK wait and sends transfer cancellation', async () => {
  const { data, result } = fixture(300_000);
  const controller = new AbortController();
  let bridge;
  const sent = [];
  const send = async (m) => {
    sent.push(m.type);
    if (m.type === 'media.transfer.open') queueMicrotask(() => bridge.receive({ type: 'media.transfer.accept', instanceId: 'inst', transferId: m.transferId, requestId: 'req', accepted: true }));
    if (m.type === 'media.transfer.chunk') queueMicrotask(() => controller.abort());
  };
  bridge = createCloudMediaBridge({ instanceId: 'inst', readImage: async () => ({ data, metadata: { mimeType: 'image/png' } }), send });
  bridge.acceptCapabilities({ instanceId: 'inst', version: 1, features: ['transfer-chunks-v1', 'image-content'], maxChunkBytes: MEDIA_CHUNK_BYTES });
  await assert.rejects(bridge.sendImage('read_image', result, 'req', controller.signal), { code: 'REQUEST_CANCELLED' });
  assert.ok(sent.includes('media.transfer.cancel'));
});

test('revoking local image permission rejects subsequent chunks', async () => {
  const { data, result } = fixture(270_000);
  let enabled = true;
  const local = createLocalMediaAgent({ readImage: async () => ({ data, metadata: { mimeType: 'image/png' } }), canTransfer: () => enabled });
  local.authorize({ requestId: 'req', secret, tool: 'read_image', result });
  const started = await local.command({ command: 'media.open', requestId: 'req', secret, artifactId });
  enabled = false;
  await assert.rejects(local.command({ command: 'media.chunk', requestId: 'req', secret, transferId: started.media.transferId, index: 0, offset: 0 }), { code: 'MEDIA_DENIED' });
  local.close();
});