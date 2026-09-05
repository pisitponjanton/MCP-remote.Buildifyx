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

test('update --restart restarts Cloud and only Local instances that were already running', async () => {
  const calls = [];
  const running = [{ instanceId: 'inst_local_a', live: true, mode: 'background', processOnly: false }];
  await runUpdateCommand(['--restart'], {
    update: async () => { calls.push('update'); },
    restartCloud: async (args) => { calls.push(['cloud', ...args]); },
    restartLocal: async (args, options) => { calls.push(['local', ...args, options.environment.kind]); },
    listLocalInstances: async () => running,
    getLocalGatewayStatus: async () => ({ running: true, state: { port: 3333 } }),
    stopLocalGateway: async (environment) => { calls.push(['gateway-stop', environment.kind]); },
    startLocalGateway: async ({ environment, port, version }) => { calls.push(['gateway-start', environment.kind, port, version]); },
    getPackageMetadata: async () => ({ version: '0.3.1' })
  });
  assert.deepEqual(calls, [
    'update',
    ['cloud', '--all'],
    ['gateway-stop', 'local'],
    ['gateway-start', 'local', 3333, '0.3.1'],
    ['local', 'inst_local_a', 'local']
  ]);

  calls.length = 0;
  await runUpdateCommand(['--restart'], {
    update: async () => { calls.push('update'); },
    restartCloud: async (args) => { calls.push(['cloud', ...args]); },
    restartLocal: async (args) => { calls.push(['local', ...args]); },
    listLocalInstances: async () => running,
    getLocalGatewayStatus: async () => ({ running: false, state: null }),
    readLocalGatewayConfig: async () => ({ port: 4444 }),
    stopLocalGateway: async () => { throw new Error('stopped gateway should not be stopped again'); },
    startLocalGateway: async ({ port }) => { calls.push(['gateway-start', port]); },
    getPackageMetadata: async () => ({ version: '0.3.1' })
  });
  assert.deepEqual(calls, [
    'update',
    ['cloud', '--all'],
    ['gateway-start', 4444],
    ['local', 'inst_local_a']
  ]);

  calls.length = 0;
  await runUpdateCommand([], {
    update: async () => { calls.push('update'); },
    getLocalGatewayStatus: async () => { throw new Error('should not inspect Local without --restart'); },
    listLocalInstances: async () => { throw new Error('should not inspect Local without --restart'); }
  });
  assert.deepEqual(calls, ['update']);
});
