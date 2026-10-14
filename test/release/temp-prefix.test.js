import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { requireIsolatedReleasePrefix } from '../../scripts/release-temp-prefix.js';

test('release validators allow only absolute child prefixes within the host temporary directory', () => {
  const temporary = path.resolve(os.tmpdir());
  const isolated = path.join(temporary, 'bdxa-validation', 'fresh');
  assert.equal(requireIsolatedReleasePrefix(isolated), isolated);
  assert.throws(() => requireIsolatedReleasePrefix(), /absolute/);
  assert.throws(() => requireIsolatedReleasePrefix('.'), /absolute/);
  assert.throws(() => requireIsolatedReleasePrefix(temporary), /temporary/);
  assert.throws(() => requireIsolatedReleasePrefix(process.cwd()), /checkout/);
  assert.throws(() => requireIsolatedReleasePrefix(path.join(process.cwd(), 'a-disposable-test-directory')), /checkout/);
  assert.throws(() => requireIsolatedReleasePrefix(temporary + '-other/fresh'), /temporary/);
  assert.throws(() => requireIsolatedReleasePrefix(path.join(temporary, 'bdxa-validation', '..', '..', 'elsewhere')), /temporary/);
});

test('GitHub Actions may safely use a separate RUNNER_TEMP location on Windows/Linux/macOS', () => {
  // This synthetic root is intentionally outside the provided fake os.tmpdir.
  const runnerTemp = path.join(os.homedir(), '.bdxa-test-synthetic-runner-temp');
  const fakeSystemTemp = path.join(os.homedir(), '.bdxa-test-synthetic-os-temp');
  const isolated = path.join(runnerTemp, 'fresh');
  assert.throws(() => requireIsolatedReleasePrefix(isolated, {
    env: { CI: 'false', RUNNER_TEMP: runnerTemp }, tempDirectory: fakeSystemTemp
  }), /temporary/);
  assert.equal(requireIsolatedReleasePrefix(isolated, {
    env: { CI: 'true', RUNNER_TEMP: runnerTemp }, tempDirectory: fakeSystemTemp
  }), isolated);
  assert.throws(() => requireIsolatedReleasePrefix(runnerTemp, {
    env: { CI: 'true', RUNNER_TEMP: runnerTemp }, tempDirectory: fakeSystemTemp
  }), /temporary/);
  assert.throws(() => requireIsolatedReleasePrefix(path.join(runnerTemp + '-sibling', 'fresh'), {
    env: { CI: 'true', RUNNER_TEMP: runnerTemp }, tempDirectory: fakeSystemTemp
  }), /temporary/);
  assert.throws(() => requireIsolatedReleasePrefix(path.join(runnerTemp, '..', 'elsewhere'), {
    env: { CI: 'true', RUNNER_TEMP: runnerTemp }, tempDirectory: fakeSystemTemp
  }), /temporary/);
  assert.throws(() => requireIsolatedReleasePrefix(isolated, {
    env: { CI: 'true', RUNNER_TEMP: 'relative/path' }, tempDirectory: fakeSystemTemp
  }), /temporary/);
});

test('release temp guard refuses symlinked install prefixes and ancestor directories', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-release-link-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'actual-target');
  await mkdir(target);
  const link = path.join(root, 'link-to-target');
  try {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
      t.skip('Windows runner does not grant symlink/junction creation in this environment');
      return;
    }
    throw error;
  }
  assert.equal(requireIsolatedReleasePrefix(target), target);
  assert.throws(() => requireIsolatedReleasePrefix(link), /symlink|junction|link/i);
  assert.throws(() => requireIsolatedReleasePrefix(path.join(link, 'nested', 'fresh')), /symlink|junction|link/i);
});
