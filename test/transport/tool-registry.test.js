import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolManifest, getMcpToolDefinitions, parseMcpToolInput } from '../../src/transport/mcp/tools/registry.js';

test('tool registry exposes the complete MCP tool list', () => {
  const definitions = getMcpToolDefinitions({ fullAccess: false });
  assert.deepEqual(
    definitions.map((tool) => tool.name).sort(),
    [
      'clear_workspace_plan',
      'complete_workspace_phase',
      'create_workspace_plan',
      'edit_file',
      'get_system_info',
      'get_workspace_plan',
      'list_directory',
      'read_file',
      'run_command',
      'update_workspace_plan_intent',
      'write_file'
    ]
  );
});

test('tool manifest is deterministic and fingerprints definition changes', () => {
  const first = createToolManifest({ fullAccess: false });
  const second = createToolManifest({ fullAccess: false });
  const fullAccess = createToolManifest({ fullAccess: true });

  assert.equal(first.count, 11);
  assert.equal(first.hash, second.hash);
  assert.equal(first.shortHash.length, 8);
  assert.notEqual(first.hash, fullAccess.hash);
  assert.equal(first.tools.every((tool) => tool.name && tool.inputSchema), true);
  assert.equal(first.tools.some((tool) => tool.name === 'get_workspace_plan'), true);
});

test('local tool input validation applies defaults and rejects malformed cloud payloads', () => {
  assert.deepEqual(parseMcpToolInput('run_command', { command: 'git' }), {
    command: 'git',
    args: [],
    cwd: '.',
    timeoutMs: 15_000
  });
  assert.deepEqual(parseMcpToolInput('read_file', { path: 'README.md', startLine: 10, endLine: 30 }), {
    path: 'README.md',
    startLine: 10,
    endLine: 30
  });
  assert.deepEqual(parseMcpToolInput('read_file', { path: 'README.md' }), { path: 'README.md' });
  assert.deepEqual(parseMcpToolInput('get_workspace_plan', {}), {});
  assert.deepEqual(parseMcpToolInput('complete_workspace_phase', {
    expectedRevision: 4,
    phaseId: 4
  }), {
    expectedRevision: 4,
    phaseId: 4
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
    () => parseMcpToolInput('read_file', { path: 'README.md', startLine: 0, endLine: 10 }),
    (error) => error?.code === 'INVALID_INPUT'
  );
  assert.throws(
    () => parseMcpToolInput('read_file', { path: 'README.md', startLine: 20, endLine: 10 }),
    (error) => error?.code === 'INVALID_INPUT'
  );
  assert.throws(
    () => parseMcpToolInput('write_file', { path: 'x.txt', content: 'x'.repeat((1024 * 1024) + 1) }),
    (error) => error?.code === 'INVALID_INPUT'
  );
  assert.throws(
    () => parseMcpToolInput('update_workspace_plan_intent', { expectedRevision: 4 }),
    (error) => error?.code === 'INVALID_INPUT'
  );

  assert.throws(
    () => parseMcpToolInput('create_workspace_plan', {
      title: 'Too many phases',
      taskGoal: 'Reject before normalization overflows the persisted plan.',
      scope: ['Validate capacity.'],
      constraints: ['Keep review final.'],
      acceptanceCriteria: ['Invalid drafts are rejected at the MCP boundary.'],
      phases: Array.from({ length: 127 }, (_, index) => ({
        type: 'implementation',
        title: `Phase ${index + 1}`,
        goal: `Goal ${index + 1}`
      }))
    }),
    (error) => error?.code === 'INVALID_INPUT' && error?.details?.toolName === 'create_workspace_plan'
  );
  assert.throws(
    () => parseMcpToolInput('create_workspace_plan', {
      title: 'Non-final review',
      taskGoal: 'Reject invalid review placement.',
      scope: ['Validate review placement.'],
      constraints: ['Review must be final.'],
      acceptanceCriteria: ['Invalid drafts are rejected at the MCP boundary.'],
      phases: [
        { type: 'review_diff', title: 'Review', goal: 'Review early.' },
        { type: 'test', title: 'Tests', goal: 'Run tests.' }
      ]
    }),
    (error) => error?.code === 'INVALID_INPUT'
  );
  assert.throws(
    () => parseMcpToolInput('complete_workspace_phase', {
      expectedRevision: 4,
      phaseId: 6,
      review: { passed: false, findings: ['A'.repeat(5000), 'B'.repeat(5000)] }
    }),
    (error) => error?.code === 'INVALID_INPUT' && error?.details?.toolName === 'complete_workspace_phase'
  );
  assert.throws(
    () => parseMcpToolInput('missing_tool', {}),
    (error) => error?.code === 'TOOL_NOT_FOUND'
  );
});
