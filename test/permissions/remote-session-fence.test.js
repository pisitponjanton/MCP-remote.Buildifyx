import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createPolicyManager } from '../../src/permissions/manager.js';
import { normalizePolicy } from '../../src/permissions/policy.js';
import { loadPolicy, savePolicy } from '../../src/permissions/store.js';
import { createManagementHandler, MANAGEMENT_ACTIONS } from '../../src/services/management.js';

async function fixture(action) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bdxa-management-session-fixture-'));
  const filePath = path.join(directory, 'policy.json');
  try {
    await savePolicy(normalizePolicy(), filePath);
    const manager = createPolicyManager(await loadPolicy(filePath), { filePath });
    const handle = createManagementHandler({
      policyManager: manager,
      instance: { instanceId: 'test-instance', name: 'fixture', path: directory, mode: 'foreground' },
      getConnectionState: () => ({ status: 'connected' })
    });
    return await action({ filePath, handle, manager });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
function context(isCurrent) {
  return { requestId: 'test-' + Math.random(), assertCurrent: isCurrent };
}

test('old session cannot commit a delayed permission write after authenticated reconnect', async () => {
  await fixture(async ({ filePath, handle }) => {
    let oldSession = true;
    const lock = await open(filePath + '.lock', 'wx');
    try {
      const old = handle('permission.set', { category: 'browserSensitive', action: 'allow' }, context(() => oldSession));
      const oldRejected = assert.rejects(old, error => error?.code === 'MANAGEMENT_SESSION_STALE');
      await delay(30); // session A is waiting for the policy file lock
      oldSession = false; // same Agent instance, WebSocket B has superseded A
      const newer = handle('permission.set', { category: 'browserSensitive', action: 'ask' }, context(() => true));
      await lock.close();
      await rm(filePath + '.lock', { force: true });
      await oldRejected;
      const updated = await newer;
      assert.equal(updated.policy.categories.browserSensitive, 'ask');
      assert.equal((await loadPolicy(filePath)).categories.browserSensitive, 'ask');
    } finally {
      await lock.close().catch(() => undefined);
      await rm(filePath + '.lock', { force: true });
    }
  });
});

test('permission.settled is a per-category barrier that cannot bypass a pending write', async () => {
  await fixture(async ({ filePath, handle }) => {
    assert.ok(MANAGEMENT_ACTIONS.includes('permission.settled'));
    const lock = await open(filePath + '.lock', 'wx');
    try {
      let barrierDone = false;
      const previous = handle('permission.set', { category: 'browserExternal', action: 'deny' }, context(() => true));
      const barrier = handle('permission.settled', { category: 'browserExternal' }, context(() => true))
        .then(result => { barrierDone = true; return result; });
      await delay(30);
      assert.equal(barrierDone, false, 'barrier may not ACK before prior category write finishes');
      await lock.close();
      await rm(filePath + '.lock', { force: true });
      await previous;
      const result = await barrier;
      assert.equal(result.settled, true);
      assert.equal(result.category, 'browserExternal');
      assert.equal(result.policy.categories.browserExternal, 'deny');
    } finally {
      await lock.close().catch(() => undefined);
      await rm(filePath + '.lock', { force: true });
    }
  });
});

test('a stale session fails both the permission barrier and permission mutation', async () => {
  await fixture(async ({ filePath, handle }) => {
    const stale = context(() => false);
    await assert.rejects(handle('permission.settled', { category: 'browserRead' }, stale),
      error => error?.code === 'MANAGEMENT_SESSION_STALE');
    await assert.rejects(handle('permission.set', { category: 'browserRead', action: 'allow' }, stale),
      error => error?.code === 'MANAGEMENT_SESSION_STALE');
    assert.equal((await loadPolicy(filePath)).categories.browserRead, 'ask');
  });
});

test('settled barrier does not accept an unknown permission category', async () => {
  await fixture(async ({ handle }) => {
    await assert.rejects(handle('permission.settled', { category: '__proto__' }),
      error => error?.code === 'INVALID_INPUT');
  });
});

test('new Agent publishes authoritative policy on generation handoff before tool authorization', async () => {
  await fixture(async ({filePath,handle,manager}) => {
    const {createPolicyManager}=await import('../../src/permissions/manager.js');
    const {createPermissionController}=await import('../../src/permissions/controller.js');
    const {randomUUID}=await import('node:crypto');
    const oldManager=createPolicyManager(await loadPolicy(filePath),{filePath});
    const newManager=createPolicyManager(await loadPolicy(filePath),{filePath});
    await oldManager.claimRemoteGeneration(randomUUID());
    await oldManager.setCategory('browserRead','deny');
    assert.equal(newManager.get().categories.browserRead,'deny', 'authorization always reads the latest persisted policy');
    await newManager.claimRemoteGeneration(randomUUID());
    assert.equal(newManager.get().categories.browserRead,'deny');
    const authorize=createPermissionController({root:filePath,policyManager:newManager,approvalQueue:null});
    await assert.rejects(authorize('browser_snapshot',{},'fixture-no-browser'),(error)=>error.code==='PERMISSION_DENIED');
    assert.equal((await loadPolicy(filePath)).categories.browserRead,'deny');
  });
});

test('authoritative authorization rejects local policy revocation from another live process after generation handoff', async () => {
  await fixture(async ({filePath}) => {
    const {createPolicyManager}=await import('../../src/permissions/manager.js');
    const {createPermissionController}=await import('../../src/permissions/controller.js');
    const {randomUUID}=await import('node:crypto');
    const {savePolicy}=await import('../../src/permissions/store.js');
    const {normalizePolicy}=await import('../../src/permissions/policy.js');
    const initial=normalizePolicy();initial.categories.browserRead='allow';
    await savePolicy(initial,filePath);
    const older=createPolicyManager(await loadPolicy(filePath),{filePath});
    const active=createPolicyManager(await loadPolicy(filePath),{filePath});
    await older.claimRemoteGeneration(randomUUID());
    await active.claimRemoteGeneration(randomUUID());
    await older.setCategory('browserRead','deny');
    assert.equal(active.get().categories.browserRead,'deny');
    const authorize=createPermissionController({root:filePath,policyManager:active,approvalQueue:null});
    await assert.rejects(authorize('browser_snapshot',{},'fixture'),error=>error.code==='PERMISSION_DENIED');
    const latest=await loadPolicy(filePath);
    assert.equal(latest.categories.browserRead,'deny');
  });
});
