import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { AgentError } from '../../core/errors.js';

export const MEDIA_VERSION = 1;
export const MEDIA_CHUNK_BYTES = 128 * 1024;
export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
export const MAX_MEDIA_TRANSFERS = 4;
export const MEDIA_IDLE_MS = 30_000;
export const MEDIA_TOOLS = new Set(['read_image', 'resize_image', 'get_cached_image', 'browser_screenshot']);
export const MEDIA_FEATURE = 'transfer-chunks-v1';
export const MEDIA_CAPABILITIES = Object.freeze({ version: 1, features: [MEDIA_FEATURE, 'image-content', 'image-import-v1'], maxChunkBytes: MEDIA_CHUNK_BYTES });

export function mediaError(code, message) { return new AgentError(code, message); }
export function isMediaResult(tool, result) {
  return MEDIA_TOOLS.has(tool) && typeof result?.artifactId === 'string' && result?.imageBytesDelivered === false;
}
export function digest(data) { return createHash('sha256').update(data).digest('hex'); }
export function equalDigest(left, right) {
  if (!/^[0-9a-f]{64}$/.test(left ?? '') || !/^[0-9a-f]{64}$/.test(right ?? '')) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
export function createMediaTransferRegistry({ readImage, now = () => Date.now() } = {}) {
  const sessions = new Map();
  if (typeof readImage !== 'function') throw new TypeError('readImage is required');
  function prune() {
    for (const [id, session] of sessions) if (session.expiresAt <= now()) {
      session.data.fill(0);
      sessions.delete(id);
    }
  }
  async function open({ requestId, secret, artifactId, tool, result }) {
    prune();
    if (sessions.size >= MAX_MEDIA_TRANSFERS) throw mediaError('MEDIA_BUSY', 'Too many active image transfers.');
    if (typeof requestId !== 'string' || requestId.length > 128 || !/^[0-9a-f]{64}$/.test(secret ?? '')
      || !isMediaResult(tool, result) || result.artifactId !== artifactId) {
      throw mediaError('MEDIA_DENIED', 'Image transfer request was not authorized.');
    }
    const { data, metadata } = await readImage(artifactId);
    if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_MEDIA_BYTES
      || !['image/png', 'image/jpeg', 'image/webp'].includes(metadata?.mimeType)
      || metadata.mimeType !== result.mimeType || !equalDigest(digest(data), result.sha256)) {
      throw mediaError('MEDIA_INVALID', 'Image transfer integrity or MIME validation failed.');
    }
    const transferId = 'transfer_' + randomUUID();
    const ownedData = Buffer.from(data);
    sessions.set(transferId, { data: ownedData, requestId, secret, artifactId, offset: 0,
      expiresAt: now() + MEDIA_IDLE_MS, mimeType: metadata.mimeType, sha256: digest(data) });
    return { version: MEDIA_VERSION, transferId, mimeType: metadata.mimeType, size: data.length,
      sha256: digest(data), chunkBytes: MEDIA_CHUNK_BYTES, expiresAt: now() + MEDIA_IDLE_MS };
  }
  function requireSession({ transferId, requestId, secret }) {
    prune();
    const item = sessions.get(transferId);
    if (!item || item.requestId !== requestId || item.secret !== secret)
      throw mediaError('MEDIA_DENIED', 'Image transfer has expired or ownership is invalid.');
    item.expiresAt = now() + MEDIA_IDLE_MS;
    return item;
  }
  function chunk({ transferId, requestId, secret, index, offset }) {
    const item = requireSession({ transferId, requestId, secret });
    if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(offset) || offset !== item.offset
      || index !== Math.floor(item.offset / MEDIA_CHUNK_BYTES))
      throw mediaError('MEDIA_ORDER', 'Image chunks must be read sequentially without gaps or repeats.');
    const bytes = item.data.subarray(item.offset, Math.min(item.offset + MEDIA_CHUNK_BYTES, item.data.length));
    const reply = { transferId, index, offset: item.offset, length: bytes.length,
      data: bytes.toString('base64'), done: item.offset + bytes.length === item.data.length };
    item.offset += bytes.length;
    return reply;
  }
  function finish({ transferId, requestId, secret }) {
    const item = requireSession({ transferId, requestId, secret });
    if (item.offset !== item.data.length) throw mediaError('MEDIA_INCOMPLETE', 'Transfer is incomplete.');
    sessions.delete(transferId);
    item.data.fill(0);
    return { completed: true };
  }
  function cancel({ transferId, requestId, secret }) {
    const item = requireSession({ transferId, requestId, secret });
    sessions.delete(transferId);
    item.data.fill(0);
    return { cancelled: true };
  }
  function close() { for (const item of sessions.values()) item.data.fill(0); sessions.clear(); }
  return { open, chunk, finish, cancel, close, prune, get active() { return sessions.size; } };
}

export async function receiveChunks({ open, chunk, finish, cancel, signal, maxBytes = MAX_MEDIA_BYTES }) {
  let transferId = null;
  try {
    if (signal?.aborted) throw mediaError('REQUEST_CANCELLED', 'Image transfer cancelled.');
    const offer = await open();
    transferId = offer.transferId;
    if (offer.version !== MEDIA_VERSION || !Number.isInteger(offer.size) || offer.size < 1 || offer.size > maxBytes
      || !['image/png', 'image/jpeg', 'image/webp'].includes(offer.mimeType)
      || !/^[0-9a-f]{64}$/.test(offer.sha256 ?? '') || offer.chunkBytes > MEDIA_CHUNK_BYTES) {
      throw mediaError('MEDIA_INVALID', 'Image transfer offer exceeds supported limits.');
    }
    const data = Buffer.alloc(offer.size);
    let offset = 0;
    for (let index = 0; offset < offer.size; index++) {
      if (signal?.aborted) throw mediaError('REQUEST_CANCELLED', 'Image transfer cancelled.');
      const value = await chunk({ transferId, index, offset });
      const bytes = Buffer.from(value?.data ?? '', 'base64');
      if (value?.transferId !== transferId || value?.index !== index || value?.offset !== offset
        || !bytes.length || bytes.length > MEDIA_CHUNK_BYTES || bytes.length !== value.length
        || offset + bytes.length > offer.size || bytes.toString('base64') !== value.data) {
        throw mediaError('MEDIA_INVALID', 'Invalid, oversized or out-of-order image chunk.');
      }
      bytes.copy(data, offset);
      offset += bytes.length;
      if (Boolean(value.done) !== (offset === offer.size)) throw mediaError('MEDIA_INVALID', 'Incorrect transfer termination.');
    }
    if (!equalDigest(digest(data), offer.sha256)) throw mediaError('MEDIA_CHECKSUM', 'Image transfer checksum mismatch.');
    await finish({ transferId });
    return { data, mimeType: offer.mimeType, size: offer.size, sha256: offer.sha256 };
  } catch (error) {
    if (transferId) await Promise.resolve().then(() => cancel({ transferId })).catch(() => undefined);
    throw error;
  }
}
