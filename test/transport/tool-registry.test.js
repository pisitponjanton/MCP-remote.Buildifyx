import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolManifest, getMcpToolDefinitions } from '../../src/transport/mcp/tools/registry.js';

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
