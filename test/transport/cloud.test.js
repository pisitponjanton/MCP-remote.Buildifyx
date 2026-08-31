import assert from 'node:assert/strict';
import test from 'node:test';
import { getCloudEndpoints, normalizeCloudOrigin } from '../../src/transport/cloud.js';

test('cloud endpoints use Buildifyx production domain by default', () => {
  const endpoints = getCloudEndpoints();
  assert.equal(endpoints.origin, 'https://bdxa.buildifyx.com');
  assert.equal(endpoints.loginUrl, 'https://bdxa.buildifyx.com/api/auth/device-login');
  assert.equal(endpoints.meUrl, 'https://bdxa.buildifyx.com/api/device/me');
  assert.equal(endpoints.logoutUrl, 'https://bdxa.buildifyx.com/api/device/logout');
  assert.equal(endpoints.agentUrl, 'wss://bdxa.buildifyx.com/agent');
});

test('cloud origin normalization accepts internal http development endpoints', () => {
  assert.equal(normalizeCloudOrigin('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.equal(getCloudEndpoints('http://127.0.0.1:8080').agentUrl, 'ws://127.0.0.1:8080/agent');
});
