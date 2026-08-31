import assert from 'node:assert/strict';
import test from 'node:test';
import { detectProfile, PROFILES } from '../src/tui/profiles.js';
import { normalizePolicy } from '../src/permissions/policy.js';
import { isFullAccessPolicy } from '../src/permissions/evaluator.js';

test('permission profiles detect auto, read only and full access', () => {
  assert.equal(detectProfile(normalizePolicy()), 'auto');
  assert.equal(detectProfile(normalizePolicy({ categories: PROFILES.readOnly.categories })), 'readOnly');
  const full = normalizePolicy({ categories: PROFILES.fullAccess.categories });
  assert.equal(detectProfile(full), 'fullAccess');
  assert.equal(isFullAccessPolicy(full), true);
});

test('custom policy is detected when categories differ from presets', () => {
  const policy = normalizePolicy({ categories: { read: 'deny' } });
  assert.equal(detectProfile(policy), 'custom');
});
