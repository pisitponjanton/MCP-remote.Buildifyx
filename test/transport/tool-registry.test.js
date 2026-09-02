import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolManifest, getMcpToolDefinitions, parseMcpToolInput } from '../../src/transport/mcp/tools/registry.js';

test('tool registry exposes the complete MCP tool list', () => {
  const definitions = getMcpToolDefinitions({ fullAccess: false });
  assert.deepEqual(
    definitions.map((tool) => tool.name).sort(),
    ['edit_file', 'get_system_info', 'list_directory', 'read_file', 'run_command', 'write_file']
  );
});

test('tool manifest is deterministic and fingerprints definition changes', () => {
  const first = createToolManifest({ fullAccess: false });
  const second = createToolManifest({ fullAccess: false });
  const fullAccess = createToolManifest({ fullAccess: true });

  assert.equal(first.count, 6);
  assert.equal(first.hash, second.hash);
  assert.equal(first.shortHash.length, 8);
  assert.notEqual(first.hash, fullAccess.hash);
  assert.equal(first.tools.every((tool) => tool.name && tool.inputSchema), true);
});

test('local tool input validation applies defaults and rejects malformed cloud payloads', () => {
  assert.deepEqual(parseMcpToolInput('run_command', { command: 'git' }), {
    command: 'git',
    args: [],
    cwd: '.',
    timeoutMs: 15_000
  });
  assert.throws(
    () => parseMcpToolInput('run_command', { command: 'git', timeoutMs: 90_000 }),
    (error) => error?.code === 'INVALID_INPUT' && error?.details?.toolName === 'run_command'
  );
  assert.throws(
    () => parseMcpToolInput('read_file', { path: '' }),
    (error) => error?.code === 'INVALID_INPUT'
  );
  assert.throws(
    () => parseMcpToolInput('read_file', { path: 'x'.repeat(5000) }),
    (error) => error?.code === 'INVALID_INPUT'
  );
  assert.throws(
    () => parseMcpToolInput('write_file', { path: 'x.txt', content: 'x'.repeat((1024 * 1024) + 1) }),
    (error) => error?.code === 'INVALID_INPUT'
  );
  assert.throws(
    () => parseMcpToolInput('missing_tool', {}),
    (error) => error?.code === 'TOOL_NOT_FOUND'
  );
});
