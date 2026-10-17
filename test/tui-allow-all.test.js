import assert from 'node:assert/strict';
import test from 'node:test';
import { createPolicyManager } from '../src/permissions/manager.js';
import { DEFAULT_POLICY, normalizePolicy } from '../src/permissions/policy.js';
import { applyProfile, detectProfile, PROFILES } from '../src/tui/profiles.js';

test('Allow All explicitly grants all 16 categories atomically for one workspace', async () => {
  const manager = createPolicyManager(normalizePolicy({
    categories: { browserSensitive: 'deny', outsideRoot: 'deny', imageRead: 'deny' },
    additionalRoots: ['/trusted/root'],
    commandRules: [{ executable: 'git', argsPrefix: ['status'], action: 'deny' }]
  }));
  let publications = 0;
  manager.subscribe(() => publications++);
  await applyProfile(manager, 'allowAll');
  const policy = manager.get();
  assert.equal(Object.keys(DEFAULT_POLICY.categories).length, 16);
  assert.deepEqual(Object.keys(PROFILES.allowAll.categories).sort(), Object.keys(DEFAULT_POLICY.categories).sort());
  assert.equal(publications, 1, 'Single persisted policy update, not 16 intermediate grants');
  assert.ok(Object.values(policy.categories).every((decision) => decision === 'allow'));
  assert.equal(detectProfile(policy), 'allowAll');
  assert.deepEqual(policy.additionalRoots, ['/trusted/root']);
  assert.deepEqual(policy.commandRules, [{ executable: 'git', argsPrefix: ['status'], action: 'deny' }]);
});

test('Legacy base 5 presets do not silently alter advanced decisions', async () => {
  const manager = createPolicyManager();
  await applyProfile(manager, 'allowAll');
  await applyProfile(manager, 'readOnly');
  assert.equal(manager.get().categories.browserSensitive, 'allow');
  assert.equal(manager.get().categories.imageRead, 'allow');
  assert.equal(manager.get().categories.write, 'ask');
  assert.equal(detectProfile(manager.get()), 'readOnly');
});
