import { randomUUID } from 'node:crypto';
import { digest, equalDigest, MEDIA_CHUNK_BYTES, MEDIA_IDLE_MS, MAX_MEDIA_BYTES, MAX_MEDIA_TRANSFERS, mediaError } from './protocol.js';

export function createMediaUploadRegistry({ commitImage, authorize, now = () => Date.now() }) {
  if (typeof commitImage !== 'function' || typeof authorize !== 'function') throw new TypeError('Upload requires validation/commit and explicit authorization callbacks.');
  const sessions = new Map();
  function prune() {
    for (const [id, item] of sessions) if (item.expiresAt <= now()) {
      item.data.fill(0);
      sessions.delete(id);
    }
  }
  async function open({ ownerKey, requestId, secret, size, sha256, mimeType, purpose = 'temporary-image-import' }) {
    prune();
    if (!/^[a-z0-9_-]{16,128}$/.test(ownerKey ?? '') || !/^[0-9a-f]{64}$/.test(secret ?? '')
      || typeof requestId !== 'string' || !requestId || requestId.length > 128
      || !Number.isInteger(size) || size < 1 || size > MAX_MEDIA_BYTES
      || !/^[0-9a-f]{64}$/.test(sha256 ?? '')
      || !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)
      || purpose !== 'temporary-image-import') throw mediaError('MEDIA_INVALID', 'Upload offer is invalid.');
    if (sessions.size >= MAX_MEDIA_TRANSFERS) throw mediaError('MEDIA_BUSY', 'Too many active upload sessions.');
    if (!await authorize({ ownerKey, requestId, purpose, operation: 'open' }))
      throw mediaError('MEDIA_DENIED', 'Upload requires explicit source and workspace authorization.');
    const transferId = 'transfer_' + randomUUID();
    sessions.set(transferId, { data: Buffer.alloc(size), size, sha256, mimeType, requestId, secret, ownerKey,
      offset: 0, expiresAt: now() + MEDIA_IDLE_MS });
    return { transferId, version: 1, chunkBytes: MEDIA_CHUNK_BYTES, size };
  }
  async function requireSession({ transferId, ownerKey, requestId, secret, operation }) {
    prune();
    const item = sessions.get(transferId);
    if (!item || item.ownerKey !== ownerKey || item.requestId !== requestId || item.secret !== secret)
      throw mediaError('MEDIA_DENIED', 'Upload identity is invalid or expired.');
    if (!await authorize({ ownerKey, requestId, operation, purpose: 'temporary-image-import' }))
      throw mediaError('MEDIA_DENIED', 'Upload authorization was revoked.');
    item.expiresAt = now() + MEDIA_IDLE_MS;
    return item;
  }
  async function chunk({ transferId, ownerKey, requestId, secret, index, offset, data }) {
    const item = await requireSession({ transferId, ownerKey, requestId, secret, operation: 'chunk' });
    const bytes = typeof data === 'string' ? Buffer.from(data, 'base64') : Buffer.alloc(0);
    if (!Number.isInteger(index) || !Number.isInteger(offset) || offset !== item.offset
      || index !== Math.floor(offset / MEDIA_CHUNK_BYTES)
      || !bytes.length || bytes.length > MEDIA_CHUNK_BYTES || offset + bytes.length > item.size
      || bytes.toString('base64') !== data)
      throw mediaError('MEDIA_ORDER', 'Upload chunk is invalid, oversized, duplicated or out of order.');
    bytes.copy(item.data, offset);
    item.offset += bytes.length;
    return { transferId, offset: item.offset, index, done: item.offset === item.size };
  }
  async function complete({ transferId, ownerKey, requestId, secret }) {
    const item = await requireSession({ transferId, ownerKey, requestId, secret, operation: 'complete' });
    try {
      if (item.offset !== item.size || !equalDigest(digest(item.data), item.sha256))
        throw mediaError('MEDIA_CHECKSUM', 'Upload length or SHA-256 mismatch.');
      const committed = await commitImage({ data: item.data, mimeType: item.mimeType, ownerKey, requestId });
      if (typeof committed?.artifactId !== 'string') throw mediaError('MEDIA_INVALID', 'Upload did not create a validated temporary artifact.');
      return committed;
    } finally { sessions.delete(transferId); item.data.fill(0); }
  }
  async function cancel({ transferId, ownerKey, requestId, secret }) {
    const item = await requireSession({ transferId, ownerKey, requestId, secret, operation: 'cancel' });
    sessions.delete(transferId);
    item.data.fill(0);
    return { cancelled: true };
  }
  function close() { for (const item of sessions.values()) item.data.fill(0); sessions.clear(); }
  return { open, chunk, complete, cancel, close, prune, get active() { return sessions.size; } };
}
