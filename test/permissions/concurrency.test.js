import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPolicyManager } from '../../src/permissions/manager.js';
import {
  instancePolicyPath,
  loadInstancePolicy,
  loadPolicy,
  resetInstancePolicy,
  savePolicy,
  workspacePolicyPath
} from '../../src/permissions/store.js';
import { normalizePolicy } from '../../src/permissions/policy.js';

test('workspace roots keep separate legacy policy paths', () => {
  const frontend = workspacePolicyPath('/tmp/buildifyx/frontend');
  const backend = workspacePolicyPath('/tmp/buildifyx/backend');
  assert.notEqual(frontend, backend);
  assert.equal(frontend, workspacePolicyPath('/tmp/buildifyx/frontend'));
});

test('instance policies are keyed only by instanceId', () => {
  const first = instancePolicyPath('inst_first');
  const second = instancePolicyPath('inst_second');
  assert.notEqual(first, second);
  assert.equal(first, instancePolicyPath('inst_first'));
});

test('same-workspace instances persist independent permissions, roots, and command rules', async () => {
  const baseDirectory = await mkdtemp(path.join(os.tmpdir(), 'bdxa-instance-policy-'));

  try {
    const firstPath = instancePolicyPath('inst_first', baseDirectory);
    const secondPath = instancePolicyPath('inst_second', baseDirectory);
    const first = createPolicyManager(await loadInstancePolicy('inst_first', baseDirectory), { filePath: firstPath });
    const second = createPolicyManager(await loadInstancePolicy('inst_second', baseDirectory), { filePath: secondPath });

    await first.setCategory('write', 'deny');
    await first.addRoot('/tmp/first-extra-root');
    await first.addCommandRule({ executable: 'npm', argsPrefix: ['test'], action: 'allow' });

    const firstSaved = await loadPolicy(firstPath);
    const secondSaved = await loadPolicy(secondPath);

    assert.equal(firstSaved.categories.write, 'deny');
    assert.equal(secondSaved.categories.write, 'allow');
    assert.equal(firstSaved.additionalRoots.includes(path.resolve('/tmp/first-extra-root')), true);
    assert.equal(secondSaved.additionalRoots.includes(path.resolve('/tmp/first-extra-root')), false);
    assert.equal(firstSaved.commandRules.some((rule) => rule.executable === 'npm' && rule.argsPrefix?.[0] === 'test'), true);
    assert.equal(secondSaved.commandRules.some((rule) => rule.executable === 'npm' && rule.argsPrefix?.[0] === 'test'), false);
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
});

test('new instances never inherit legacy workspace or device policy', async () => {
  const baseDirectory = await mkdtemp(path.join(os.tmpdir(), 'bdxa-instance-default-'));
  const root = '/tmp/buildifyx/shared-project';

  try {
    await savePolicy({
      categories: { write: 'deny', outsideRoot: 'deny' },
      additionalRoots: ['/tmp/legacy-extra'],
      commandRules: [{ executable: 'npm', argsPrefix: ['test'], action: 'allow' }]
    }, workspacePolicyPath(root, baseDirectory));

    await savePolicy({
      categories: { read: 'deny' },
      additionalRoots: ['/tmp/device-extra']
    }, path.join(baseDirectory, 'policy.json'));

    const fresh = await loadInstancePolicy('inst_fresh', baseDirectory);
    assert.deepEqual(fresh, normalizePolicy());
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
});

test('same instanceId keeps policy until reset, then reopens at defaults', async () => {
  const baseDirectory = await mkdtemp(path.join(os.tmpdir(), 'bdxa-instance-reset-'));
  const instanceId = 'inst_reset';

  try {
    const filePath = instancePolicyPath(instanceId, baseDirectory);
    const manager = createPolicyManager(await loadInstancePolicy(instanceId, baseDirectory), { filePath });
    await manager.setCategory('write', 'deny');
    await manager.addRoot('/tmp/instance-extra');
    await manager.addCommandRule({ executable: 'git', argsPrefix: ['status'], action: 'allow' });

    const persisted = await loadInstancePolicy(instanceId, baseDirectory);
    assert.equal(persisted.categories.write, 'deny');
    assert.deepEqual(persisted.additionalRoots, [path.resolve('/tmp/instance-extra')]);
    assert.equal(persisted.commandRules.length, 1);

    await resetInstancePolicy(instanceId, baseDirectory);
    const reopened = await loadInstancePolicy(instanceId, baseDirectory);
    assert.deepEqual(reopened, normalizePolicy());
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
});

test('resetting one instance does not change another instance policy', async () => {
  const baseDirectory = await mkdtemp(path.join(os.tmpdir(), 'bdxa-instance-rm-reset-'));

  try {
    const firstId = 'inst_remove_me';
    const secondId = 'inst_keep_me';
    const firstPath = instancePolicyPath(firstId, baseDirectory);
    const secondPath = instancePolicyPath(secondId, baseDirectory);
    const first = createPolicyManager(await loadInstancePolicy(firstId, baseDirectory), { filePath: firstPath });
    const second = createPolicyManager(await loadInstancePolicy(secondId, baseDirectory), { filePath: secondPath });

    await first.addRoot('/tmp/first-root');
    await first.setCategory('write', 'deny');
    await second.addRoot('/tmp/second-root');
    await second.setCategory('read', 'deny');

    await resetInstancePolicy(firstId, baseDirectory);

    assert.deepEqual(await loadInstancePolicy(firstId, baseDirectory), normalizePolicy());
    const secondSaved = await loadInstancePolicy(secondId, baseDirectory);
    assert.equal(secondSaved.categories.read, 'deny');
    assert.deepEqual(secondSaved.additionalRoots, [path.resolve('/tmp/second-root')]);
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
});

test('concurrent policy managers merge changes through the policy file lock', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bdxa-policy-lock-'));
  const filePath = path.join(directory, 'policy.json');
  const initial = normalizePolicy();
  const first = createPolicyManager(initial, { filePath });
  const second = createPolicyManager(initial, { filePath });

  try {
    await Promise.all([
      first.addRoot('/tmp/frontend-shared'),
      second.addCommandRule({ executable: 'npm', argsPrefix: ['test'], action: 'allow' })
    ]);

    const saved = await loadPolicy(filePath);
    assert.equal(saved.additionalRoots.includes(path.resolve('/tmp/frontend-shared')), true);
    assert.equal(saved.commandRules.some((rule) => rule.executable === 'npm' && rule.argsPrefix?.[0] === 'test'), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
