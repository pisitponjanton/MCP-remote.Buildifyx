import assert from 'node:assert/strict';
import test from 'node:test';
import { runUpdateCommand } from '../../src/cli/main.js';
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
  assert.deepEqual(parseInvocation(['--restart-child', '--instance-id', 'inst_test']), {
    command: 'cloud',
    args: ['--restart-child', '--instance-id', 'inst_test']
  });
});

test('instance management commands preserve docker-style arguments', () => {
  assert.deepEqual(parseInvocation(['ls']), { command: 'ls', args: [] });
  assert.deepEqual(parseInvocation(['ls', '-q']), { command: 'ls', args: ['-q'] });
  assert.deepEqual(parseInvocation(['inspect', 'backend']), { command: 'inspect', args: ['backend'] });
  assert.deepEqual(parseInvocation(['attach', 'backend']), { command: 'attach', args: ['backend'] });
  assert.deepEqual(parseInvocation(['start', 'backend']), { command: 'start', args: ['backend'] });
  assert.deepEqual(parseInvocation(['stop', 'backend']), { command: 'stop', args: ['backend'] });
  assert.deepEqual(parseInvocation(['stop', '--all']), { command: 'stop', args: ['--all'] });
  assert.deepEqual(parseInvocation(['restart', 'backend']), { command: 'restart', args: ['backend'] });
  assert.deepEqual(parseInvocation(['restart', '--all']), { command: 'restart', args: ['--all'] });
  assert.deepEqual(parseInvocation(['autostart', 'backend']), { command: 'autostart', args: ['backend'] });
  assert.deepEqual(parseInvocation(['autostart', 'off', 'backend']), { command: 'autostart', args: ['off', 'backend'] });
  assert.deepEqual(parseInvocation(['rm', '-f', 'backend']), { command: 'rm', args: ['-f', 'backend'] });
  assert.deepEqual(parseInvocation(['rm', '--all']), { command: 'rm', args: ['--all'] });
});

test('login command preserves login arguments', () => {
  assert.deepEqual(parseInvocation(['login', '--token', 'example']), { command: 'login', args: ['--token', 'example'] });
});

test('update --restart runs update before restarting all background instances', async () => {
  const calls = [];
  await runUpdateCommand(['--restart'], {
    update: async () => { calls.push('update'); },
    restart: async (args) => { calls.push(['restart', ...args]); }
  });
  assert.deepEqual(calls, ['update', ['restart', '--all']]);

  calls.length = 0;
  await runUpdateCommand([], {
    update: async () => { calls.push('update'); },
    restart: async () => { calls.push('restart'); }
  });
  assert.deepEqual(calls, ['update']);
});
