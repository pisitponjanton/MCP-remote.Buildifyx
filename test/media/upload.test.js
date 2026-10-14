import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { createMediaUploadRegistry } from '../../src/transport/media/upload.js';
import { digest, MEDIA_CHUNK_BYTES } from '../../src/transport/media/protocol.js';

const ownerKey = 'owner_1234567890abcdef1234567890abcdef';
const secret = randomBytes(32).toString('hex');
test('authorized 4 MiB+ upload reassembles bounded chunks and commits only after checksum', async () => {
  const input = randomBytes(4 * 1024 * 1024 + 111);
  let commits = 0;
  const registry = createMediaUploadRegistry({
    authorize: async ({ ownerKey: checked }) => checked === ownerKey,
    commitImage: async ({ data, mimeType }) => {
      commits++;
      assert.deepEqual(data, input);
      assert.equal(mimeType, 'image/png');
      return { artifactId: 'art_test' };
    }
  });
  const offer = await registry.open({ ownerKey, requestId: 'req', secret, size: input.length, sha256: digest(input), mimeType: 'image/png' });
  let offset = 0;
  for (let i = 0; offset < input.length; i++) {
    const part = input.subarray(offset, offset + MEDIA_CHUNK_BYTES);
    const ack = await registry.chunk({ transferId: offer.transferId, ownerKey, requestId: 'req', secret,
      index: i, offset, data: part.toString('base64') });
    offset += part.length;
    assert.equal(ack.offset, offset);
  }
  assert.equal(commits, 0);
  assert.deepEqual(await registry.complete({ transferId: offer.transferId, ownerKey, requestId: 'req', secret }), { artifactId: 'art_test' });
  assert.equal(commits, 1);
  assert.equal(registry.active, 0);
});
test('upload cross-owner access and duplicate or malformed chunks are rejected', async () => {
  const buffer = randomBytes(33_000);
  const registry = createMediaUploadRegistry({ authorize: async () => true, commitImage: async () => ({ artifactId: 'a' }) });
  const offer = await registry.open({ ownerKey, requestId: 'req', secret, size: buffer.length, sha256: digest(buffer), mimeType: 'image/jpeg' });
  const fields = { transferId: offer.transferId, ownerKey, requestId: 'req', secret };
  await assert.rejects(registry.chunk({ ...fields, ownerKey: 'owner_badbadbadbadbadbad', index: 0, offset: 0, data: buffer.toString('base64') }), { code: 'MEDIA_DENIED' });
  await assert.rejects(registry.chunk({ ...fields, index: 1, offset: 0, data: buffer.toString('base64') }), { code: 'MEDIA_ORDER' });
  await registry.chunk({ ...fields, index: 0, offset: 0, data: buffer.toString('base64') });
  await assert.rejects(registry.chunk({ ...fields, index: 0, offset: 0, data: buffer.toString('base64') }), { code: 'MEDIA_ORDER' });
  await registry.cancel(fields);
  assert.equal(registry.active, 0);
});
test('upload fails closed on checksum mismatch, revoked approval and expiration', async () => {
  let time = 0, approved = true, commits = 0;
  const buffer = randomBytes(4096);
  const registry = createMediaUploadRegistry({
    now: () => time,
    authorize: async () => approved,
    commitImage: async () => { commits++; return { artifactId: 'a' }; }
  });
  const offer = await registry.open({ ownerKey, requestId: 'req', secret, size: buffer.length,
    sha256: 'f'.repeat(64), mimeType: 'image/webp' });
  const args = { transferId: offer.transferId, ownerKey, requestId: 'req', secret };
  await registry.chunk({ ...args, index: 0, offset: 0, data: buffer.toString('base64') });
  await assert.rejects(registry.complete(args), { code: 'MEDIA_CHECKSUM' });
  assert.equal(registry.active, 0);
  assert.equal(commits, 0);
  const correct = await registry.open({ ownerKey, requestId: 'req2', secret, size: buffer.length,
    sha256: digest(buffer), mimeType: 'image/png' });
  approved = false;
  await assert.rejects(registry.chunk({ ...args, transferId: correct.transferId, requestId: 'req2', index: 0, offset: 0, data: buffer.toString('base64') }), { code: 'MEDIA_DENIED' });
  approved = true;
  time = 40_000;
  registry.prune();
  assert.equal(registry.active, 0);
});
test('upload refuses unapproved source and oversized declared size', async () => {
  const registry = createMediaUploadRegistry({ authorize: async () => false, commitImage: async () => ({ artifactId: 'x' }) });
  await assert.rejects(registry.open({ ownerKey, requestId: 'req', secret, size: 1024, sha256: digest(Buffer.alloc(1024)), mimeType: 'image/png' }), { code: 'MEDIA_DENIED' });
  await assert.rejects(registry.open({ ownerKey, requestId: 'req', secret, size: 17 * 1024 * 1024, sha256: digest(Buffer.alloc(16)), mimeType: 'image/png' }), { code: 'MEDIA_INVALID' });
});
