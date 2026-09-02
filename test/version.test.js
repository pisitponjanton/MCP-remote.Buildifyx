import assert from 'node:assert/strict';
import test from 'node:test';
import { checkForUpdate, compareVersions, formatUpdateNotice, resolveAttachedUpdateStatus } from '../src/version.js';

test('compareVersions compares semantic versions', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.4', '1.2.3'), 1);
  assert.equal(compareVersions('1.3.0', '1.2.9'), 1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
});

test('compareVersions handles prerelease versions', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.1'), 1);
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
});

test('formatUpdateNotice explains how to update', () => {
  assert.equal(
    formatUpdateNotice({ currentVersion: '0.2.0', latestVersion: '0.2.1', updateAvailable: true }),
    'Update available: v0.2.0 → v0.2.1. Run `bdxa update`.'
  );
  assert.equal(formatUpdateNotice({ currentVersion: '0.2.1', latestVersion: '0.2.1', updateAvailable: false }), null);
});

test('checkForUpdate detects a newer npm version', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ version: '0.2.1' })
  });
  try {
    const status = await checkForUpdate('@buildifyx/desktop-agent', '0.2.0');
    assert.equal(status.currentVersion, '0.2.0');
    assert.equal(status.latestVersion, '0.2.1');
    assert.equal(status.updateAvailable, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('attached dashboard detects an older running agent after package update', () => {
  const status = resolveAttachedUpdateStatus({
    runningVersion: '0.2.0',
    installedVersion: '0.2.1',
    updateStatus: { currentVersion: '0.2.1', latestVersion: '0.2.1', updateAvailable: false }
  });
  assert.equal(status.restartRequired, true);
  assert.equal(status.runningVersion, '0.2.0');
  assert.equal(status.installedVersion, '0.2.1');

  const current = resolveAttachedUpdateStatus({
    runningVersion: '0.2.1',
    installedVersion: '0.2.1',
    updateStatus: { currentVersion: '0.2.1', latestVersion: '0.2.2', updateAvailable: true }
  });
  assert.equal(current.restartRequired, false);
  assert.equal(current.updateAvailable, true);
});
