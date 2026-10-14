import { successResult } from '../mcp/response.js';
import { equalDigest, digest, MAX_MEDIA_BYTES, mediaError } from './protocol.js';

export function mediaMcpResult(result, image) {
  if (!Buffer.isBuffer(image?.data) || image.data.length < 1 || image.data.length > MAX_MEDIA_BYTES
    || image.mimeType !== result.mimeType || !equalDigest(digest(image.data), result.sha256))
    throw mediaError('MEDIA_INVALID', 'MCP image bytes do not match validated metadata.');
  const metadata = { ...result, imageBytesDelivered: true };
  const base = successResult(metadata);
  return { ...base, content: [...base.content, {
    type: 'image', mimeType: image.mimeType, data: image.data.toString('base64')
  }] };
}
