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

test('command service preserves non-zero exit codes', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-command-exit-')));
  try {
    const runCommand = createCommandService({ root, fullAccess: true });
    const result = await runCommand({ command: 'node', args: ['-e', 'process.exit(7)'] });
    assert.equal(result.exitCode, 7);
    assert.equal(result.timedOut, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('command service marks timed-out commands and terminates them', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-command-timeout-')));
  try {
    const runCommand = createCommandService({ root, fullAccess: true });
    const result = await runCommand({ command: 'node', args: ['-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 50 });
    assert.equal(result.timedOut, true);
    assert.equal(typeof result.exitCode, 'number');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('command service rejects missing executables', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-command-missing-')));
  try {
    const runCommand = createCommandService({ root, fullAccess: true });
    await assert.rejects(
      runCommand({ command: 'bdxa-command-that-does-not-exist', args: [] }),
      /Failed to start bdxa-command-that-does-not-exist/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('command service enforces stdout and stderr byte limits', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-command-output-')));
  try {
    const runCommand = createCommandService({ root, fullAccess: true });
    await assert.rejects(
      runCommand({ command: 'node', args: ['-e', `process.stdout.write('x'.repeat(${commandLimits.maxOutputBytes + 1024}))`] }),
      /stdout exceeded/
    );
    await assert.rejects(
      runCommand({ command: 'node', args: ['-e', `process.stderr.write('x'.repeat(${commandLimits.maxOutputBytes + 1024}))`] }),
      /stderr exceeded/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stopAll finishes bounded cleanup for active commands', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-command-stop-')));
  try {
    const runCommand = createCommandService({ root, fullAccess: true });
    const execution = runCommand(
      { command: 'node', args: ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 10000);"], timeoutMs: 10000 },
      { requestId: 'req_stop_all' }
    );
    for (let index = 0; index < 100 && runCommand.getActiveRequestIds().length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const startedAt = Date.now();
    assert.equal(await runCommand.stopAll(new Error('stop all test')), true);
    assert.ok(Date.now() - startedAt < 2500);
    await assert.rejects(execution, /stop all test/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
