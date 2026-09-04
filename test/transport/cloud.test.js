import assert from 'node:assert/strict';
import test from 'node:test';
import { getCloudEndpoints, MANAGEMENT_PROTOCOL_VERSION, MAX_CLOUD_FRAME_BYTES, normalizeCloudOrigin } from '../../src/transport/cloud.js';

test('cloud endpoints use Buildifyx production domain by default', () => {
  const endpoints = getCloudEndpoints();
  assert.equal(endpoints.origin, 'https://bdxa.buildifyx.com');
  assert.equal(endpoints.loginUrl, 'https://bdxa.buildifyx.com/api/auth/device-login');
  assert.equal(endpoints.meUrl, 'https://bdxa.buildifyx.com/api/device/me');
  assert.equal(endpoints.logoutUrl, 'https://bdxa.buildifyx.com/api/device/logout');
  assert.equal(endpoints.agentUrl, 'wss://bdxa.buildifyx.com/agent');
  assert.equal(MAX_CLOUD_FRAME_BYTES, 4 * 1024 * 1024);
  assert.equal(MANAGEMENT_PROTOCOL_VERSION, 1);
});

test('cloud origin normalization accepts local http development endpoints', () => {
  assert.equal(normalizeCloudOrigin('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.equal(normalizeCloudOrigin('http://localhost:8080/'), 'http://localhost:8080');
  assert.equal(getCloudEndpoints('http://127.0.0.1:8080').agentUrl, 'ws://127.0.0.1:8080/agent');
});

test('cloud origin normalization rejects plaintext remote endpoints', () => {
  assert.throws(
    () => normalizeCloudOrigin('http://example.com'),
    /must use https/
  );
  assert.throws(
    () => normalizeCloudOrigin('https://user:pass@example.com'),
    /must not include embedded credentials/
  );
  assert.equal(normalizeCloudOrigin('https://example.com/'), 'https://example.com');
});
