import assert from 'node:assert/strict';
import test from 'node:test';
import { parseInvocation } from '../../src/cli/options.js';

test('bdxa defaults to cloud mode', () => {
  assert.deepEqual(parseInvocation([]), { command: 'cloud', args: [] });
  assert.deepEqual(parseInvocation(['--root', '/tmp/project']), { command: 'cloud', args: ['--root', '/tmp/project'] });
  assert.deepEqual(parseInvocation(['--unrestricted-commands']), { command: 'cloud', args: ['--unrestricted-commands'] });
});

test('local mode remains explicitly available', () => {
  assert.deepEqual(parseInvocation(['local', '--port', '3333']), { command: 'local', args: ['--port', '3333'] });
});

test('login command preserves login arguments', () => {
  assert.deepEqual(parseInvocation(['login', '--token', 'example']), { command: 'login', args: ['--token', 'example'] });
});
