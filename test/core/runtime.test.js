import assert from 'node:assert/strict';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ErrorCode } from '../../src/core/errors.js';
import { createPermissionPolicy, PermissionAction } from '../../src/core/permissions.js';
import { createRuntime } from '../../src/core/runtime.js';

async function withTemp(callback) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-runtime-')));
  try { return await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('runtime dispatches system and file services', async () => {
  await withTemp(async (root) => {
    await writeFile(path.join(root, 'hello.txt'), 'hello');
    const runtime = createRuntime({ root });
    const info = await runtime.dispatch('get_system_info');
    const file = await runtime.dispatch('read_file', { path: 'hello.txt' });
    assert.equal(info.allowedRoot, root);
    assert.equal(file.content, 'hello');
  });
});

test('runtime returns typed permission and unknown-tool errors', async () => {
  await withTemp(async (root) => {
    const permissions = createPermissionPolicy({ write: PermissionAction.DENY, command: PermissionAction.CONFIRM });
    const runtime = createRuntime({ root, permissions });
    await assert.rejects(runtime.dispatch('write_file', { path: 'x.txt', content: 'x' }), (error) => error.code === ErrorCode.PERMISSION_DENIED);
    await assert.rejects(runtime.dispatch('run_command', { command: 'git', args: ['--version'] }), (error) => error.code === ErrorCode.CONFIRMATION_REQUIRED);
    await assert.rejects(runtime.dispatch('missing_tool'), (error) => error.code === ErrorCode.TOOL_NOT_FOUND);
  });
});

test('runtime event history compacts large command arguments', async () => {
  await withTemp(async (root) => {
    const permissions = createPermissionPolicy({ command: PermissionAction.DENY });
    const runtime = createRuntime({ root, permissions });
    const hugeArg = 'x'.repeat(4096);
    await assert.rejects(runtime.dispatch('run_command', { command: 'git', args: Array(20).fill(hugeArg) }));
    const started = runtime.eventBus.getHistory().find((event) => event.type === 'tool.started');
    assert.equal(started.input.args.length, 13);
    assert.match(started.input.args[0], /more chars/);
    assert.equal(started.input.args.at(-1), '<8 more args>');
  });
});

test('runtime cancellation terminates an active command process tree', async () => {
  await withTemp(async (root) => {
    const sentinel = path.join(root, 'late-child-output.txt');
    const grandchildScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'late'), 1200);`;
    const parentScript = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' }); setTimeout(() => {}, 5000);`;
    const runtime = createRuntime({ root, fullAccess: true });
    const requestId = 'req_cancel_process_tree';
    const execution = runtime.dispatch('run_command', {
      command: 'node',
      args: ['-e', parentScript],
      timeoutMs: 5000
    }, { requestId });

    for (let index = 0; index < 100 && !runtime.services.run_command.getActiveRequestIds().includes(requestId); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(runtime.services.run_command.getActiveRequestIds().includes(requestId), true);
    assert.equal(runtime.cancel(requestId, 'Cancelled by test'), true);
    await assert.rejects(execution, (error) => error?.code === ErrorCode.REQUEST_CANCELLED);
    assert.equal(runtime.services.run_command.getActiveRequestIds().includes(requestId), false);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    await assert.rejects(access(sentinel), (error) => error?.code === 'ENOENT');
  });
});

test('force stop terminates an active command without waiting for graceful timeout', async () => {
  await withTemp(async (root) => {
    const runtime = createRuntime({ root, fullAccess: true });
    const requestId = 'req_force_stop';
    const execution = runtime.dispatch('run_command', {
      command: 'node',
      args: ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 10000);"],
      timeoutMs: 10000
    }, { requestId });

    for (let index = 0; index < 100 && !runtime.services.run_command.getActiveRequestIds().includes(requestId); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(runtime.services.run_command.getActiveRequestIds().includes(requestId), true);

    const startedAt = Date.now();
    await runtime.stop('Force stop test', { force: true });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 1400, `force stop took ${elapsed} ms`);
    await assert.rejects(execution, (error) => error?.code === ErrorCode.REQUEST_CANCELLED);
    assert.equal(runtime.services.run_command.getActiveRequestIds().length, 0);
  });
});

test('runtime rejects duplicate active request ids and completed replays', async () => {
  await withTemp(async (root) => {
    const runtime = createRuntime({ root });
    let release;
    let started = 0;
    const gate = new Promise((resolve) => { release = resolve; });
    runtime.services.get_system_info = async () => {
      started += 1;
      await gate;
      return { allowedRoot: root };
    };
    const requestId = 'req_duplicate_runtime';
    const first = runtime.dispatch('get_system_info', {}, { requestId });
    for (let index = 0; index < 50 && started === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(started, 1);

    await assert.rejects(
      runtime.dispatch('get_system_info', {}, { requestId }),
      (error) => error?.code === ErrorCode.INVALID_INPUT && error?.details?.state === 'active'
    );
    const duplicateEvents = runtime.eventBus.getHistory().filter((event) => event.requestId === requestId);
    assert.equal(duplicateEvents.filter((event) => event.type === 'tool.started').length, 1);
    assert.equal(duplicateEvents.filter((event) => event.type === 'tool.rejected').length, 1);
    assert.equal(duplicateEvents.some((event) => event.type === 'tool.failed'), false);
    release();
    await first;

    await assert.rejects(
      runtime.dispatch('get_system_info', {}, { requestId }),
      (error) => error?.code === ErrorCode.INVALID_INPUT && error?.details?.state === 'completed'
    );
    assert.equal(started, 1);
  });
});

test('runtime stop rejects requests that arrive after shutdown begins', async () => {
  await withTemp(async (root) => {
    const runtime = createRuntime({ root });
    await runtime.stop('Stopping for test');
    assert.equal(runtime.acceptingRequests, false);
    await assert.rejects(
      runtime.dispatch('get_system_info', {}, { requestId: 'req_after_stop' }),
      (error) => error?.code === ErrorCode.REQUEST_CANCELLED
    );
  });
});
