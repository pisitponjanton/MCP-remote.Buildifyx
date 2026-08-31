import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commandLimits, createCommandService, validateCommandPolicy } from '../../src/services/commands.js';

test('restricted command policy blocks arbitrary runtimes and package executors', () => {
  assert.throws(() => validateCommandPolicy('node', ['-e', '1']), /not allowed in restricted mode/);
  assert.throws(() => validateCommandPolicy('python', ['-c', 'print(1)']), /not allowed in restricted mode/);
  assert.throws(() => validateCommandPolicy('npx', ['foo']), /not allowed in restricted mode/);
  assert.throws(() => validateCommandPolicy('npm', ['exec', 'foo']), /npm exec is not allowed/);
  assert.equal(commandLimits.maxTimeoutMs, 60_000);
});

test('full access allows runtimes', () => {
  assert.doesNotThrow(() => validateCommandPolicy('node', ['-e', '1'], { fullAccess: true }));
});

test('command service executes allowed commands and rejects cwd traversal', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-command-')));
  try {
    const runCommand = createCommandService({ root });
    const result = await runCommand({ command: 'git', args: ['--version'] });
    assert.equal(result.exitCode, 0);
    await assert.rejects(runCommand({ command: 'git', args: ['--version'], cwd: '..' }), /outside the allowed root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
