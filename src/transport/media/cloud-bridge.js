import { randomBytes } from 'node:crypto';
import { createMediaTransferRegistry, isMediaResult, MEDIA_CAPABILITIES, MEDIA_CHUNK_BYTES, MEDIA_FEATURE, mediaError } from './protocol.js';

const ACK_TIMEOUT_MS = 10_000;
const acceptedTypes = new Set(['media.transfer.accept', 'media.transfer.ack', 'media.transfer.received']);

export function createCloudMediaBridge({ readImage, instanceId, send, canTransfer = () => true, now = () => Date.now() }) {
  const transfers = createMediaTransferRegistry({ readImage, now });
  const pending = new Map();
  let active = false;
  let closed = false;
  let negotiatedMaxChunk = MEDIA_CHUNK_BYTES;
  function wait(type, transferId, verify, signal) {
    const key = type + ':' + transferId;
    if (pending.has(key)) throw mediaError('MEDIA_BUSY', 'A media acknowledgement is already pending.');
    return new Promise((resolve, reject) => {
      function cleanup() { clearTimeout(timeout); pending.delete(key); signal?.removeEventListener('abort', onAbort); }
      function onAbort() { cleanup(); reject(mediaError('REQUEST_CANCELLED', 'Cloud media transfer cancelled.')); }
      const timeout = setTimeout(() => { cleanup(); reject(mediaError('MEDIA_TIMEOUT', 'Cloud media acknowledgement timed out.')); }, ACK_TIMEOUT_MS);
      timeout.unref?.();
      pending.set(key, (message) => {
        cleanup();
        if (!verify(message)) reject(mediaError('MEDIA_INVALID', 'Invalid Cloud media acknowledgement.'));
        else resolve(message);
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  async function sendAndWait(type, transferId, message, responseType, verify, signal) {
    const reply = wait(responseType, transferId, verify, signal);
    try {
      await send({ type, instanceId, transferId, ...message });
      return await reply;
    } catch (error) {
      stop();
      throw error;
    }
  }
  function acceptCapabilities(message) {
    if (closed || message.instanceId !== instanceId || message.version !== 1
      || !Array.isArray(message.features) || !message.features.includes(MEDIA_FEATURE)
      || !message.features.includes('image-content')
      || !Number.isInteger(message.maxChunkBytes) || message.maxChunkBytes < MEDIA_CHUNK_BYTES) {
      active = false;
      return false;
    }
    negotiatedMaxChunk = Math.min(MEDIA_CHUNK_BYTES, message.maxChunkBytes);
    active = true;
    return true;
  }
  function receive(message) {
    if (!acceptedTypes.has(message?.type)) return false;
    if (!active || message.instanceId !== instanceId || typeof message.transferId !== 'string') return false;
    const key = message.type + ':' + message.transferId;
    const callback = pending.get(key);
    if (callback) callback(message);
    return true;
  }
  async function sendImage(tool, result, requestId, signal) {
    if (!active || closed || !isMediaResult(tool, result)) return null;
    if (!await canTransfer(tool, result)) throw mediaError('MEDIA_DENIED', 'Media permission was revoked.');
    const secret = randomBytes(32).toString('hex');
    let transferId;
    try {
      const offer = await transfers.open({ tool, result, requestId, secret, artifactId: result.artifactId });
      transferId = offer.transferId;
      await sendAndWait('media.transfer.open', transferId, {
        requestId, artifactId: result.artifactId, version: 1,
        size: offer.size, sha256: offer.sha256, mimeType: offer.mimeType, chunkBytes: negotiatedMaxChunk
      }, 'media.transfer.accept', (m) => m.requestId === requestId && m.accepted === true, signal);
      let offset = 0;
      for (let index = 0; offset < offer.size; index++) {
        if (!await canTransfer(tool, result)) throw mediaError('MEDIA_DENIED', 'Media permission was revoked.');
        if (signal?.aborted || closed || !active) throw mediaError('REQUEST_CANCELLED', 'Cloud media transfer cancelled.');
        // Registry emits 128 KiB chunks; negotiation must allow at least this chunk size.
        const part = transfers.chunk({ transferId, requestId, secret, index, offset });
        if (part.length > negotiatedMaxChunk) throw mediaError('UNSUPPORTED_CAPABILITY', 'Cloud accepted a smaller chunk than Agent supports.');
        await sendAndWait('media.transfer.chunk', transferId, {
          requestId, index, offset, length: part.length, data: part.data
        }, 'media.transfer.ack', (m) => m.requestId === requestId && m.offset === offset + part.length && m.index === index, signal);
        offset += part.length;
      }
      if (!await canTransfer(tool, result)) throw mediaError('MEDIA_DENIED', 'Media permission was revoked.');
      await sendAndWait('media.transfer.complete', transferId, {
        requestId, size: offer.size, sha256: offer.sha256
      }, 'media.transfer.received', (m) => m.requestId === requestId && m.size === offer.size && m.sha256 === offer.sha256, signal);
      transfers.finish({ transferId, requestId, secret });
      return { version: 1, transferId, mimeType: offer.mimeType, size: offer.size, sha256: offer.sha256 };
    } catch (error) {
      if (transferId) {
        try { transfers.cancel({ transferId, requestId, secret }); } catch {}
        await send({ type: 'media.transfer.cancel', instanceId, requestId, transferId }).catch(() => undefined);
      }
      throw error;
    }
  }
  function stop() {
    closed = true;
    active = false;
    for (const fn of pending.values()) fn({ type: 'closed' });
    pending.clear();
    transfers.close();
  }
  function reset() {
    closed = false;
    active = false;
    negotiatedMaxChunk = MEDIA_CHUNK_BYTES;
  }
  return { advertised: MEDIA_CAPABILITIES, acceptCapabilities, receive, sendImage, reset, stop, get active() { return active && !closed; } };
}
