import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ErrorCode, publicToolError } from '../../src/core/errors.js';
import { createRuntime } from '../../src/core/runtime.js';
import { normalizePolicy } from '../../src/permissions/policy.js';

test('runtime returns actionable safe error codes for file, command, and missing image failures', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-phase1-errors-')));
  await mkdir(path.join(root, 'folder'));
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, 'text.txt'), 'first\nทดสอบ ✓\n');
  await writeFile(path.join(root, 'binary.txt'), Buffer.from([0xff]));
  await writeFile(path.join(root, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
  const runtime = createRuntime({
    root, fullAccess: true, interactive: false,
    policy: normalizePolicy({ categories: {
      read: 'allow', write: 'allow', command: 'allow',
      imageRead: 'allow', outsideRoot: 'deny'
    } })
  });
  async function fails(tool, args, code) {
    const error = await runtime.dispatch(tool, args).then(() => null, failure => failure);
    assert.equal(error?.code, code, tool + ': ' + String(error?.message));
    const safe = publicToolError(error);
    assert.equal(safe.code, code);
    assert.ok(safe.message && !safe.message.includes(root), 'public message must not expose root');
    return safe;
  }
  try {
    await fails('list_directory', { path: 'absent' }, ErrorCode.FILE_NOT_FOUND);
    await fails('list_directory', { path: 'text.txt' }, ErrorCode.NOT_DIRECTORY);
    await fails('read_file', { path: 'absent' }, ErrorCode.FILE_NOT_FOUND);
    await fails('read_file', { path: 'folder' }, ErrorCode.FILE_NOT_REGULAR);
    await fails('read_file', { path: 'binary.txt' }, ErrorCode.INVALID_TEXT_FILE);
    await fails('read_file', { path: 'large.txt' }, ErrorCode.FILE_TOO_LARGE);
    await fails('write_file', { path: 'text.txt', content: 'DO NOT OVERWRITE' }, ErrorCode.FILE_EXISTS);
    await fails('write_file', { path: 'no-parent/new.txt', content: 'x' }, ErrorCode.FILE_PARENT_NOT_FOUND);
    await fails('edit_file', { path: 'absent', operation: 'overwrite', content: 'x' }, ErrorCode.FILE_NOT_FOUND);
    await fails('edit_file', { path: 'text.txt', operation: 'replace_lines', startLine: 3, endLine: 2, lines: ['x'] }, ErrorCode.INVALID_INPUT);
    await fails('edit_file', { path: 'text.txt', operation: 'replace_lines', startLine: 999, endLine: 999, lines: ['x'] }, ErrorCode.INVALID_INPUT);
    await fails('run_command', { command: 'bdxa-test-nonexistent-command-040', args: [] }, ErrorCode.COMMAND_NOT_FOUND);
    await fails('run_command', { command: 'node', args: ['--version'], cwd: 'no-directory' }, ErrorCode.COMMAND_CWD_INVALID);
    await fails('run_command', { command: 'node', args: ['--version'], cwd: 'text.txt' }, ErrorCode.COMMAND_CWD_INVALID);
    await fails('read_image', { path: 'missing.png' }, 'IMAGE_NOT_FOUND');
    // Authorization resolves existing paths before checking outside-root approval.
    // A missing outside target may therefore report FILE_NOT_FOUND; neither code grants access.
    const outside = await runtime.dispatch('read_file', { path: '../outside.txt' }).then(() => null, error => error);
    assert.ok([ErrorCode.FILE_NOT_FOUND, ErrorCode.PATH_OUTSIDE_ROOT, ErrorCode.PERMISSION_DENIED].includes(outside?.code));
    assert.ok(!JSON.stringify(publicToolError(outside)).includes(root));
    await fails('read_file', { path: '.git/config' }, ErrorCode.GIT_INTERNAL_PATH);

    assert.equal(await readFile(path.join(root, 'text.txt'), 'utf8'), 'first\nทดสอบ ✓\n');
    const created = await runtime.dispatch('write_file', { path: 'new.txt', content: 'ภาษาไทย ✓\n' });
    assert.equal(created.created, true);
    assert.equal((await runtime.dispatch('read_file', { path: 'new.txt' })).content, 'ภาษาไทย ✓\n');
    const command = await runtime.dispatch('run_command', { command: 'node', args: ['--version'] });
    assert.equal(command.exitCode, 0);
    assert.equal(command.timedOut, false);
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('unexpected low-level errors are still INTERNAL_ERROR and never expose sensitive details', () => {
  const secret = 'PRIVATE_PHASE1_ERROR_4021';
  const error = Object.assign(new Error('secret='+secret), { code: 'EUNKNOWN' });
  const published = publicToolError(error);
  assert.equal(published.code, ErrorCode.INTERNAL_ERROR);
  assert.equal(JSON.stringify(published).includes(secret), false);
});
