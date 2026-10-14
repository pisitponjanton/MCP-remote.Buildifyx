import assert from 'node:assert/strict';
import test from 'node:test';
import { browserLaunchFailure } from '../../src/browser/session-engine.js';

test('Linux missing system libraries produce an actionable, redacted browser error', () => {
  const raw = new Error('Host system is missing dependencies to run browsers: libgbm.so.1 /private/token=SECRET');
  const result = browserLaunchFailure(raw, 'linux');
  assert.equal(result.code, 'BROWSER_LAUNCH_FAILED');
  assert.match(result.message, /required Linux system libraries are missing/);
  assert.match(result.message, /administrator approval/);
  assert.doesNotMatch(result.message, /SECRET|private|token=/);
});

test('Other platform or unrelated browser launch failures retain the safe generic advice', () => {
  const linux = browserLaunchFailure(new Error('Chromium crashed with password=SECRET'), 'linux');
  const mac = browserLaunchFailure(new Error('Host system is missing dependencies to run browsers password=SECRET'), 'darwin');
  for (const value of [linux, mac]) {
    assert.equal(value.code, 'BROWSER_LAUNCH_FAILED');
    assert.match(value.message, /bdxa browser check/);
    assert.doesNotMatch(value.message, /SECRET|password/);
  }
});
