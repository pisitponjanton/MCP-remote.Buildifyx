import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInvocation } from '../../src/cli/options.js';

test('bdxa defaults to cloud mode', () => {
  assert.deepEqual(parseInvocation([]), { command: 'cloud', args: [] });
  assert.deepEqual(parseInvocation(['--root', '/tmp/project']), { command: 'cloud', args: ['--root', '/tmp/project'] });
  assert.deepEqual(parseInvocation(['--unrestricted-commands']), { command: 'cloud', args: ['--unrestricted-commands'] });
  assert.deepEqual(parseInvocation(['-d', '--name', 'backend']), { command: 'cloud', args: ['-d', '--name', 'backend'] });
  assert.deepEqual(parseInvocation(['--handoff-child', '--instance-id', 'inst_test']), {
    command: 'cloud',
    args: ['--handoff-child', '--instance-id', 'inst_test']
  });
});

test('instance management commands preserve docker-style arguments', () => {
  assert.deepEqual(parseInvocation(['ls']), { command: 'ls', args: [] });
  assert.deepEqual(parseInvocation(['ls', '-q']), { command: 'ls', args: ['-q'] });
  assert.deepEqual(parseInvocation(['inspect', 'backend']), { command: 'inspect', args: ['backend'] });
  assert.deepEqual(parseInvocation(['attach', 'backend']), { command: 'attach', args: ['backend'] });
  assert.deepEqual(parseInvocation(['rm', '-f', 'backend']), { command: 'rm', args: ['-f', 'backend'] });
  assert.deepEqual(parseInvocation(['rm', '--all']), { command: 'rm', args: ['--all'] });
});

test('login command preserves login arguments', () => {
  assert.deepEqual(parseInvocation(['login', '--token', 'example']), { command: 'login', args: ['--token', 'example'] });
});
