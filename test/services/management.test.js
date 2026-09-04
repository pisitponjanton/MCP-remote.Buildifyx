import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPolicyManager } from '../../src/permissions/manager.js';
import { createManagementHandler, MANAGEMENT_ACTIONS } from '../../src/services/management.js';

function createHandler(manager, directory, overrides = {}) {
  return createManagementHandler({
    policyManager: manager,
    instance: { instanceId: 'inst_test', name: 'test', path: directory, mode: 'background', ...(overrides.instance ?? {}) },
    getConnectionState: () => ({ status: 'connected' }),
    onRestart: overrides.onRestart ?? (() => {}),
    onStop: () => {},
    onRemove: () => {},
    getAutostart: async () => false,
    setAutostart: async (enabled) => enabled
  });
}

test('remote management edits only the local instance policy through semantic actions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bdxa-management-'));
  const filePath = path.join(directory, 'policy.json');
  const manager = createPolicyManager(undefined, { filePath });
  let restarted = false;
  const handler = createHandler(manager, directory, { onRestart: () => { restarted = true; } });

  try {
    assert.equal(MANAGEMENT_ACTIONS.includes('permission.set'), true);
    await handler('permission.set', { category: 'write', action: 'deny' });
    assert.equal(manager.get().categories.write, 'deny');

    const extraRoot = path.join(directory, 'shared');
    await handler('root.add', { root: extraRoot });
    assert.deepEqual(manager.get().additionalRoots, [extraRoot]);
    await handler('root.remove', { root: extraRoot });
    assert.deepEqual(manager.get().additionalRoots, []);

    await handler('commandRule.add', { executable: 'git', argsPrefix: ['status'], action: 'allow' });
    assert.equal(manager.get().commandRules.length, 1);
    await handler('commandRule.remove', { executable: 'git', argsPrefix: ['status'] });
    assert.equal(manager.get().commandRules.length, 0);

    const settings = await handler('settings.get');
    assert.equal(settings.instance.instanceId, 'inst_test');
    assert.equal(settings.policy.categories.write, 'deny');

    const restart = await handler('instance.restart');
    assert.equal(restart.result.accepted, true);
    assert.equal(restarted, false);
    await restart.afterSend();
    assert.equal(restarted, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('remote management rejects protected/ambiguous roots, unknown actions, and background-only lifecycle changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bdxa-management-'));
  const manager = createPolicyManager(undefined, { filePath: path.join(directory, 'policy.json') });
  const background = createHandler(manager, directory);
  const foreground = createHandler(manager, directory, { instance: { mode: 'foreground' } });
  const internal = path.join(directory, '.buildifyx');
  await mkdir(internal);
  const previous = process.env.BUILDFYX_HOME;
  process.env.BUILDFYX_HOME = internal;

  try {
    await assert.rejects(
      () => background('root.add', { root: 'relative/path' }),
      (error) => error?.code === 'INVALID_INPUT'
    );
    await assert.rejects(
      () => background('root.add', { root: internal }),
      (error) => error?.code === 'INVALID_INPUT' && /internal state/.test(error.message)
    );
    await assert.rejects(
      () => background('missing.action', {}),
      (error) => error?.code === 'MANAGEMENT_ACTION_NOT_FOUND'
    );
    await assert.rejects(
      () => foreground('instance.restart', {}),
      (error) => error?.code === 'BACKGROUND_REQUIRED'
    );
    await assert.rejects(
      () => foreground('autostart.set', { enabled: true }),
      (error) => error?.code === 'BACKGROUND_REQUIRED'
    );
  } finally {
    if (previous === undefined) delete process.env.BUILDFYX_HOME;
    else process.env.BUILDFYX_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
