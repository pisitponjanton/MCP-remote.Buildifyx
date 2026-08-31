import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedOrigin } from '../../src/transport/mcp/server.js';
import { errorResult, successResult } from '../../src/transport/mcp/response.js';
import { AgentError, ErrorCode } from '../../src/core/errors.js';

test('MCP origin policy only allows localhost browser origins', () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:3000'), true);
  assert.equal(isAllowedOrigin('http://localhost:3000'), true);
  assert.equal(isAllowedOrigin('https://example.com'), false);
});

test('MCP response adapter preserves structured success and typed errors', () => {
  const success = successResult({ ok: true });
  assert.deepEqual(success.structuredContent, { ok: true });
  const failure = errorResult(new AgentError(ErrorCode.PERMISSION_DENIED, 'denied'));
  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent.error.code, ErrorCode.PERMISSION_DENIED);
});
