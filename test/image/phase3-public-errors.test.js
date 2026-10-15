import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentError, publicToolError } from '../../src/core/errors.js';

test('Phase 3: image save failures provide actionable safe client errors without disclosing internal paths', () => {
  const checks = [
    ['IMAGE_EXISTS', /Choose a new filename/],
    ['IMAGE_PATH_DENIED', /approved workspace root/],
    ['IMAGE_PATH_CHANGED', /try again/],
    ['MEDIA_IMPORT_PERMISSION_REQUIRED', /imageRead and cacheManage/],
    ['CACHE_NOT_FOUND', /Import the image again/]
  ];
  for (const [code, expected] of checks) {
    const result = publicToolError(new AgentError(code, 'SECRET_USER_PATH_OR_TOKEN'));
    assert.equal(result.code, code);
    assert.match(result.message, expected);
    assert.equal(JSON.stringify(result).includes('SECRET_USER_PATH_OR_TOKEN'), false);
  }
});
