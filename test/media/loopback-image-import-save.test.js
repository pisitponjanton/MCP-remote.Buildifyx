import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createRuntime } from '../../src/core/runtime.js';
import { normalizePolicy } from '../../src/permissions/policy.js';
import { createCloudAgent } from '../../src/transport/cloud.js';
import { MEDIA_CHUNK_BYTES } from '../../src/transport/media/protocol.js';

const sharp = createRequire(import.meta.url)('sharp');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function waitFor(predicate, label, maxMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const result = predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for ' + label);
}

async function createFixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-phase5-local-')));
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/agent' });
  await new Promise(resolve => wss.once('listening', resolve));

  const policy = normalizePolicy({
    categories: { imageRead: 'allow', cacheManage: 'allow', imageSave: 'allow', outsideRoot: 'deny' }
  });
  const runtime = createRuntime({
    root, namespace: 'cloud', interactive: false, policy,
    imageCache: {
      initialize: async () => {}, list: async () => [], close() {},
      get: async () => { throw new Error('No disk-backed image cache access allowed in test'); }
    }
  });
  const events = [], peers = [], mediaResultBytes = [];
  wss.on('connection', socket => {
    peers.push(socket);
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString());
      events.push(frame);
      const reply = (type, fields = {}) => socket.send(JSON.stringify({
        type, instanceId: 'test-instance', requestId: frame.requestId,
        transferId: frame.transferId, ...fields
      }));
      if (frame.type === 'media.transfer.open') {
        mediaResultBytes.length = 0;
        reply('media.transfer.accept', { accepted: true });
      } else if (frame.type === 'media.transfer.chunk') {
        const decoded = Buffer.from(frame.data, 'base64');
        assert.equal(decoded.length, frame.length);
        assert.ok(decoded.length <= MEDIA_CHUNK_BYTES);
        mediaResultBytes.push(decoded);
        reply('media.transfer.ack', { index: frame.index, offset: frame.offset + frame.length });
      } else if (frame.type === 'media.transfer.complete') {
        assert.equal(sha256(Buffer.concat(mediaResultBytes)), frame.sha256);
        reply('media.transfer.received', { size: frame.size, sha256: frame.sha256 });
      }
    });
  });

  const agent = createCloudAgent({
    cloudUrl: 'http://127.0.0.1:' + wss.address().port,
    credentials: { deviceId: 'disposable-device', deviceToken: 'not-a-production-token' },
    runtime, manifest: {
      count: 2, hash: 'test-manifest', manifestVersion: 1,
      tools: [{ name: 'get_cached_image' }, { name: 'save_cached_image' }]
    },
    version: '0.4.0',
    instance: { instanceId: 'test-instance', name: 'temporary-test', path: root, mode: 'background' },
    deviceInfo: { platform: process.platform, arch: process.arch },
    reconnect: false, heartbeatMs: 60000
  });
  t.after(async () => {
    await agent.stop().catch(() => {});
    await runtime.stop().catch(() => {});
    for (const socket of peers) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  agent.connect();
  const ready = await waitFor(() => events.find(m => m.type === 'device.ready'), 'device.ready');
  assert.ok(ready.capabilities.media.features.includes('image-import-v1'));
  const socket = peers[0];
  const send = frame => socket.send(JSON.stringify(frame));
  send({ type: 'media.capabilities.accept', instanceId: 'test-instance', version: 1,
    features: ['transfer-chunks-v1', 'image-content', 'image-import-v1'],
    maxChunkBytes: MEDIA_CHUNK_BYTES });
  const response = (type, requestId) => waitFor(() =>
    events.find(m => m.type === type && m.requestId === requestId), type + '/' + requestId);

  return { root, events, send, response, mediaResultBytes };
}

test('Phase 5: loopback Cloud-protocol import → actual Agent tool calls → explicit save, byte/pixel exactness', async t => {
  for (const format of ['png', 'jpeg', 'webp']) {
    await t.test(format, async inner => {
      const f = await createFixture(inner);
      const original = await sharp({ create: {
        width: 20, height: 11, channels: 3, background: '#275abb'
      } }).toFormat(format).toBuffer();
      const digest = sha256(original);
      const mimeType = 'image/' + format;
      const identity = {
        instanceId: 'test-instance', requestId: 'test-import-' + format,
        transferId: 'one-time-transfer-' + format
      };

      f.send({ type: 'media.import.open', ...identity, version: 1,
        size: original.length, mimeType, sha256: digest, chunkBytes: MEDIA_CHUNK_BYTES });
      const accepted = await f.response('media.import.accept', identity.requestId);
      assert.equal(accepted.accepted, true);

      let offset = 0;
      for (let index = 0; offset < original.length; index++) {
        const part = original.subarray(offset, offset + MEDIA_CHUNK_BYTES);
        f.send({ type: 'media.import.chunk', ...identity, index, offset,
          length: part.length, data: part.toString('base64') });
        const ack = await waitFor(() => f.events.find(m => m.type === 'media.import.ack'
          && m.requestId === identity.requestId && m.index === index), 'import ACK');
        offset += part.length;
        assert.equal(ack.offset, offset);
      }
      f.send({ type: 'media.import.complete', ...identity, sha256: digest, size: original.length });
      const imported = await f.response('media.import.received', identity.requestId);
      assert.equal(imported.sha256, digest);
      assert.match(imported.artifactId, /^art_[0-9a-f-]{36}$/);
      assert.deepEqual(await readdir(f.root), [], 'Cloud receipt must not create permanent files');

      const readRequestId = 'remote-read-' + format;
      f.send({ type: 'tool.call', instanceId: 'test-instance',
        requestId: readRequestId, tool: 'get_cached_image',
        arguments: { artifactId: imported.artifactId } });
      const readResult = await f.response('tool.result', readRequestId);
      assert.equal(readResult.result.artifactId, imported.artifactId);
      assert.equal(readResult.result.sha256, digest);
      assert.equal(readResult.result.imageBytesDelivered, false,
        'Only Cloud may decide whether MCP ImageContent reaches ChatGPT');
      assert.equal(readResult.result.mediaTransfer.sha256, digest);
      assert.deepEqual(Buffer.concat(f.mediaResultBytes), original,
        'Cloud protocol ACKed outbound transfer must match the imported image');

      const filename = 'user-approved-' + format + '.' + format;
      const saveRequestId = 'remote-save-' + format;
      f.send({ type: 'tool.call', instanceId: 'test-instance',
        requestId: saveRequestId, tool: 'save_cached_image',
        arguments: { artifactId: imported.artifactId, destinationPath: filename } });
      const result = await f.response('tool.result', saveRequestId);
      assert.equal(result.result.saved, true);
      assert.equal(result.result.sha256, digest);
      const saved = await readFile(path.join(f.root, filename));
      assert.deepEqual(saved, original);
      assert.equal(sha256(saved), digest);

      const a = await sharp(original).raw().toBuffer({ resolveWithObject: true });
      const b = await sharp(saved).raw().toBuffer({ resolveWithObject: true });
      assert.deepEqual(b.info.width, a.info.width);
      assert.deepEqual(b.info.height, a.info.height);
      assert.deepEqual(b.data, a.data);
      assert.deepEqual(await readdir(f.root), [filename]);

      // An imported artifact must never be able to overwrite a file that has
      // already been committed to the test workspace. Verify over the same
      // authenticated Cloud WebSocket tool transport, not only at service level.
      const repeatRequestId = 'remote-save-again-' + format;
      f.send({ type: 'tool.call', instanceId: 'test-instance',
        requestId: repeatRequestId, tool: 'save_cached_image',
        arguments: { artifactId: imported.artifactId, destinationPath: filename } });
      const rejected = await f.response('tool.error', repeatRequestId);
      assert.equal(rejected.error?.code, 'IMAGE_EXISTS');
      assert.deepEqual(await readdir(f.root), [filename]);
      const preserved = await readFile(path.join(f.root, filename));
      assert.equal(sha256(preserved), digest,
        'existing destination bytes must remain unchanged after rejected overwrite');
    });
  }
});
