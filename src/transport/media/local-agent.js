import { createMediaTransferRegistry, isMediaResult, mediaError } from './protocol.js';

export function createLocalMediaAgent({ readImage, canTransfer = () => true, now = () => Date.now() }) {
  const approved = new Map();
  const activeTools = new Map();
  const transfers = createMediaTransferRegistry({ readImage, now });
  function prune() { for (const [id, value] of approved) if (value.expiresAt <= now()) approved.delete(id); transfers.prune(); }
  function authorize({ requestId, secret, tool, result }) {
    prune();
    if (!isMediaResult(tool, result)) return false;
    if (typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret ?? '')
      || typeof requestId !== 'string' || requestId.length > 128)
      throw mediaError('MEDIA_DENIED', 'Missing local media transfer identity.');
    approved.set(requestId, { secret, tool, result, expiresAt: now() + 30_000 });
    if (approved.size > 16) approved.delete(approved.keys().next().value);
    return true;
  }
  async function command(message) {
    prune();
    const { requestId, secret, transferId } = message;
    const access = message.command === 'media.open'
      ? approved.get(requestId) : activeTools.get(transferId);
    const tool = access?.tool;
    const artifactId = access?.result?.artifactId ?? access?.artifactId ?? message.artifactId;
    if (message.command !== 'media.cancel' && !access)
      throw mediaError('MEDIA_DENIED', 'No authorized image transfer exists for this request.');
    if (message.command !== 'media.cancel' && !await canTransfer({ ...message, tool, artifactId })) {
      // Downgrading Allow to Ask/Deny invalidates this transfer rather than
      // merely pausing it until a later policy toggle. Purge buffered bytes
      // only when the request secret matches the original transfer.
      if (message.command === 'media.open') approved.delete(requestId);
      else if (transferId) {
        try {
          transfers.cancel({ transferId, requestId, secret });
          activeTools.delete(transferId);
        } catch { /* incorrect secret must not cancel another request */ }
      }
      throw mediaError('MEDIA_DENIED', 'Image transfer permission was revoked.');
    }
    if (message.command === 'media.open') {
      const item = approved.get(requestId);
      if (!item || item.secret !== secret || item.result.artifactId !== message.artifactId)
        throw mediaError('MEDIA_DENIED', 'Image transfer does not belong to this authorized MCP request.');
      approved.delete(requestId);
      const media = await transfers.open({ requestId, secret, artifactId: message.artifactId, tool: item.tool, result: item.result });
      activeTools.set(media.transferId, { tool: item.tool, artifactId: item.result.artifactId });
      return { media };
    }
    if (message.command === 'media.chunk') return { media: transfers.chunk({ transferId, requestId, secret, index: message.index, offset: message.offset }) };
    if (message.command === 'media.finish') {
      const media = transfers.finish({ transferId, requestId, secret });
      activeTools.delete(transferId);
      return { media };
    }
    if (message.command === 'media.cancel') {
      const media = transfers.cancel({ transferId, requestId, secret });
      activeTools.delete(transferId);
      return { media };
    }
    return undefined;
  }
  function close() { approved.clear(); activeTools.clear(); transfers.close(); }
  return { authorize, command, close };
}
