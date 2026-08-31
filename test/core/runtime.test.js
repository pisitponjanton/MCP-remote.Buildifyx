import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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
