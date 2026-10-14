import { createHash } from 'node:crypto';
import { resolveCloudCachePrincipal } from '../cache/principal.js';

// Called only with stored credentials obtained from authenticated Cloud login.
// Live-session routing remains device-token-specific; only consented on-device
// persistent profile storage uses the stable authenticated account identity.
export function resolveCloudBrowserIdentity(credentials) {
  const valid = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 512;
  if (!valid(credentials?.deviceId) || !valid(credentials?.deviceToken)) {
    throw new TypeError('Trusted device identity is required for Browser ownership.');
  }
  const scopePrincipalId = 'cloud_' + createHash('sha256')
    .update(credentials.deviceId + '\0' + credentials.deviceToken).digest('hex').slice(0,32);
  const hasStableAccount = valid(credentials.accountId) || valid(credentials.account);
  const storagePrincipalId = hasStableAccount
    ? 'browser_' + resolveCloudCachePrincipal(credentials)
    : scopePrincipalId;
  return {
    scopePrincipalId,
    storagePrincipalId,
    // Only current-token profiles may be migrated. Never enumerate old-token
    // owners or assign unknown profiles to a different authenticated account.
    legacyStoragePrincipalId: hasStableAccount ? scopePrincipalId : null
  };
}
