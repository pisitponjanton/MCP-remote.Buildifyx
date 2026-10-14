import { createHash } from 'node:crypto';

// Account identity is issued by authenticated Cloud login, never supplied by
// an MCP tool argument. No account email, token or other raw identifier is
// written into an artifact-cache directory name or metadata.
export function resolveCloudCachePrincipal(credentials) {
  const url = credentials?.cloudUrl;
  const origin = (() => {
    try {
      const target = new URL(url);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return null;
      return target.origin.toLowerCase();
    } catch { return null; }
  })();
  if (!origin) throw new TypeError('Invalid credential Cloud origin.');
  const valid = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 512;
  let identity;
  if (valid(credentials?.accountId)) identity = 'account-id:' + credentials.accountId.trim();
  else if (valid(credentials?.account)) identity = 'account-email:' + credentials.account.trim().toLowerCase();
  else if (valid(credentials?.deviceId) && valid(credentials?.deviceToken)) {
    // Older Cloud credentials can lack an account. Fall back to the *credential*
    // identity, NOT just deviceId: account swaps on a shared device must
    // never inherit an unscoped cache. This fallback is token-rotation-sensitive.
    identity = 'legacy-device-credential:' + credentials.deviceId.trim() + '\0' + credentials.deviceToken;
  } else throw new TypeError('Cannot resolve Cloud cache owner without authenticated credentials.');
  return 'cloud_cache_' + createHash('sha256').update(origin + '\0' + identity).digest('hex');
}
