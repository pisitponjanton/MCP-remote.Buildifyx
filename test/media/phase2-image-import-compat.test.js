import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createCloudAgent } from '../../src/transport/cloud.js';
import { createImageServices } from '../../src/image/service.js';
import { MEDIA_CHUNK_BYTES } from '../../src/transport/media/protocol.js';

const sharp = createRequire(import.meta.url)('sharp');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const waitFor = (check, label) => new Promise((resolve, reject) => {
  const started = Date.now();
  const next = () => {
    const found = check();
    if (found) return resolve(found);
    if (Date.now() - started > 5000) return reject(new Error('Timed out: ' + label));
    setTimeout(next, 5);
  };
  next();
});

async function harness(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'bdxa-phase2-import-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/agent' });
  await new Promise(resolve => server.once('listening', resolve));
  const messages = [], peers = [];
  server.on('connection', sock => {
    peers.push(sock);
    sock.on('message', raw => messages.push(JSON.parse(raw.toString())));
  });
  const policy = { categories: { imageRead: 'allow', cacheManage: 'allow', browserCapture: 'deny' } };
  const image = createImageServices({
    root, getPolicy: () => policy,
    cache: {
      initialize: async () => {}, close() {}, list: async () => [],
      get: async () => { throw new Error('Cloud-imported images must never hit persistent cache'); }
    }
  });
  const agent = createCloudAgent({
    cloudUrl: 'http://127.0.0.1:' + server.address().port,
    credentials: { deviceId: 'test-device', deviceToken: 'test-only-token' },
    runtime: { services: image, policyManager: { get: () => policy }, dispatch: async () => ({}), cancel() {} },
    manifest: { count: 1, hash: 'test', manifestVersion: 1, tools: [{ name: 'get_cached_image' }] },
    version: '0.4.0',
    instance: { instanceId: 'test-instance', name: 'test', path: root, mode: 'background' },
    deviceInfo: {}, reconnect: false, heartbeatMs: 60000
  });
  t.after(async () => {
    await agent.stop().catch(() => {});
    image.closeImageCache();
    for (const sock of peers) sock.terminate();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  agent.connect();
  const ready = await waitFor(() => messages.find(m => m.type === 'device.ready'), 'device.ready');
  const socket = await waitFor(() => peers[0], 'agent peer');
  const send = message => socket.send(JSON.stringify(message));
  const reply = (type, requestId) => waitFor(() => messages.find(m => m.type === type && m.requestId === requestId), type);
  return { root, ready, send, reply, image, messages };
}

test('Phase 2: previous Cloud media negotiation cannot activate inbound image import', async t => {
  const h = await harness(t);
  assert.ok(h.ready.capabilities.media.features.includes('image-import-v1'));
  h.send({ type: 'media.capabilities.accept', instanceId: 'test-instance', version: 1,
    features: ['transfer-chunks-v1', 'image-content'], maxChunkBytes: MEDIA_CHUNK_BYTES });
  const requestId = 'old-cloud-no-image-import';
  h.send({ type: 'media.import.open', instanceId: 'test-instance', requestId,
    transferId: 'old-cloud', version: 1, mimeType: 'image/png', size: 32,
    sha256: '0'.repeat(64), chunkBytes: MEDIA_CHUNK_BYTES });
  const answer = await h.reply('media.import.error', requestId);
  assert.equal(answer.code, 'UNSUPPORTED_CAPABILITY');
  assert.deepEqual(await readdir(h.root), []);
  assert.equal((await h.image.list_cached_assets()).assets.length, 0);
});

test('Phase 2: real Cloud Agent accepts >128KiB PNG in ACKed chunks, verifies bytes and stays RAM-only', async t => {
  const h = await harness(t);
  const bytes = await sharp(randomBytes(512 * 256 * 3), {
    raw: { width: 512, height: 256, channels: 3 }
  }).png().toBuffer();
  assert.ok(bytes.length > 2 * MEDIA_CHUNK_BYTES, 'Image must exercise multiple ACKed chunks');
  const hash = sha256(bytes);
  h.send({ type: 'media.capabilities.accept', instanceId: 'test-instance', version: 1,
    features: ['transfer-chunks-v1', 'image-content', 'image-import-v1'],
    maxChunkBytes: MEDIA_CHUNK_BYTES });
  const requestId = 'new-cloud-image-import', transferId = 'png-import';
  const identity = { instanceId: 'test-instance', requestId, transferId };
  h.send({ type: 'media.import.open', ...identity, version: 1, mimeType: 'image/png',
    size: bytes.length, sha256: hash, chunkBytes: MEDIA_CHUNK_BYTES });
  assert.equal((await h.reply('media.import.accept', requestId)).accepted, true);
  let offset = 0;
  for (let index = 0; offset < bytes.length; index++) {
    const chunk = bytes.subarray(offset, offset + MEDIA_CHUNK_BYTES);
    h.send({ type: 'media.import.chunk', ...identity, index, offset, length: chunk.length,
      data: chunk.toString('base64') });
    const ack = await waitFor(() => h.messages.find(m =>
      m.type === 'media.import.ack' && m.requestId === requestId && m.index === index),
    'chunk ACK ' + index);
    assert.equal(ack.offset, offset + chunk.length);
    offset += chunk.length;
  }
  h.send({ type: 'media.import.complete', ...identity, size: bytes.length, sha256: hash });
  const complete = await h.reply('media.import.received', requestId);
  assert.equal(complete.sha256, hash);
  assert.match(complete.artifactId, /^art_[0-9a-f-]{36}$/);
  const cached = await h.image.__readImageBytes(complete.artifactId);
  assert.equal(cached.data.equals(bytes), true);
  assert.equal((await h.image.get_cached_image({ artifactId: complete.artifactId })).sha256, hash);
  assert.deepEqual(await readdir(h.root), [], 'Inbound transfer must not create a workspace file');
});
