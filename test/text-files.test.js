import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isGitInternalPath, resolveSafeNewFilePath, resolveSafePath } from '../src/security/path.js';
import { registerFileTools } from '../src/tools/files.js';
import {
  MAX_TEXT_FILE_BYTES,
  countTextLines,
  createUtf8File,
  readUtf8File,
  replaceCharacters,
  replaceLines,
  writeUtf8FileAtomic
} from '../src/tools/text.js';

async function withTemporaryDirectory(callback) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'buildifyx-test-')));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function captureTools() {
  const tools = new Map();
  return {
    tools,
    server: {
      registerTool(name, config, callback) {
        tools.set(name, { config, callback });
      }
    }
  };
}

test('line helpers preserve line endings and count logical lines', () => {
  assert.equal(countTextLines(''), 1);
  assert.equal(countTextLines('one\r\ntwo\r\n'), 3);
  assert.equal(replaceLines('one\r\ntwo\r\nthree\r\n', 2, 2, ['SECOND']), 'one\r\nSECOND\r\nthree\r\n');
  assert.equal(replaceLines('one\ntwo\nthree', 2, 3, ['last']), 'one\nlast');
  assert.equal(replaceLines('one\ntwo\n', 1, 1, []), 'two\n');
  assert.throws(() => replaceLines('one\n', 1, 1, ['bad\nline']), /must not contain newline/);
});

test('character replacement uses one-based Unicode columns and supports cross-line ranges', () => {
  assert.equal(replaceCharacters('A😀B\nnext', { line: 1, column: 2 }, { line: 1, column: 3 }, 'X'), 'AXB\nnext');
  assert.equal(replaceCharacters('ab\ncd', { line: 1, column: 2 }, { line: 2, column: 2 }, 'X'), 'aXd');
  assert.throws(() => replaceCharacters('abc', { line: 1, column: 5 }, { line: 1, column: 5 }, ''), /column must be between/);
  assert.throws(() => replaceCharacters('a\nb', { line: 2, column: 2 }, { line: 1, column: 1 }, ''), /must not come before/);
});

test('safe paths reject traversal, .git internals, and symlink escapes', async () => {
  await withTemporaryDirectory(async (base) => {
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    await mkdir(path.join(root, '.git'), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(root, 'safe.txt'), 'safe');
    await writeFile(path.join(root, '.git', 'config'), 'secret');
    await writeFile(path.join(outside, 'outside.txt'), 'outside');
    await symlink(path.join(outside, 'outside.txt'), path.join(root, 'escape.txt'));

    assert.equal(await resolveSafePath(root, 'safe.txt'), path.join(root, 'safe.txt'));
    assert.equal(isGitInternalPath(root, path.join(root, '.git', 'config')), true);
    await assert.rejects(resolveSafePath(root, '../outside/outside.txt'), /outside the allowed root/);
    await assert.rejects(resolveSafePath(root, '.git/config'), /\.git internals/);
    await assert.rejects(resolveSafePath(root, 'escape.txt'), /Resolved path is outside/);
  });
});

test('new-file paths reject traversal, .git internals, missing parents, and symlink escapes', async () => {
  await withTemporaryDirectory(async (base) => {
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    await mkdir(path.join(root, '.git'), { recursive: true });
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(outside);
    await symlink(outside, path.join(root, 'external'));

    assert.equal(await resolveSafeNewFilePath(root, 'src/new.txt'), path.join(root, 'src', 'new.txt'));
    await assert.rejects(resolveSafeNewFilePath(root, '../outside.txt'), /outside the allowed root/);
    await assert.rejects(resolveSafeNewFilePath(root, '.git/new.txt'), /\.git internals/);
    await assert.rejects(resolveSafeNewFilePath(root, 'external/new.txt'), /Resolved parent path is outside/);
    await assert.rejects(resolveSafeNewFilePath(root, 'missing/new.txt'));
  });
});

test('UTF-8 reads reject binary and oversized files', async () => {
  await withTemporaryDirectory(async (root) => {
    const textPath = path.join(root, 'text.txt');
    const binaryPath = path.join(root, 'binary.dat');
    const largePath = path.join(root, 'large.txt');
    await writeFile(textPath, 'สวัสดี');
    await writeFile(binaryPath, Buffer.from([0xff, 0xfe, 0xfd]));
    await writeFile(largePath, Buffer.alloc(MAX_TEXT_FILE_BYTES + 1, 0x61));

    assert.equal(await readUtf8File(textPath), 'สวัสดี');
    await assert.rejects(readUtf8File(binaryPath), /not valid UTF-8/);
    await assert.rejects(readUtf8File(largePath), /exceeds/);
  });
});

test('new UTF-8 files are create-only and enforce the size limit', async () => {
  await withTemporaryDirectory(async (root) => {
    const filePath = path.join(root, 'created.txt');
    await createUtf8File(filePath, 'สวัสดี');
    assert.equal(await readFile(filePath, 'utf8'), 'สวัสดี');
    await assert.rejects(createUtf8File(filePath, 'overwrite'), /already exists/);
    await assert.rejects(createUtf8File(path.join(root, 'large.txt'), 'x'.repeat(MAX_TEXT_FILE_BYTES + 1)), /exceeds/);
  });
});

test('atomic writes preserve file permissions and enforce the size limit', async () => {
  await withTemporaryDirectory(async (root) => {
    const filePath = path.join(root, 'editable.txt');
    await writeFile(filePath, 'before');
    await chmod(filePath, 0o640);
    await writeUtf8FileAtomic(filePath, 'after');
    assert.equal(await readFile(filePath, 'utf8'), 'after');
    assert.equal((await lstat(filePath)).mode & 0o777, 0o640);
    await assert.rejects(writeUtf8FileAtomic(filePath, 'x'.repeat(MAX_TEXT_FILE_BYTES + 1)), /exceeds/);
    assert.equal(await readFile(filePath, 'utf8'), 'after');
  });
});

test('registered file tools read, create, and edit files', async () => {
  await withTemporaryDirectory(async (root) => {
    await writeFile(path.join(root, 'sample.txt'), 'alpha\nbeta\n');
    const { server, tools } = captureTools();
    registerFileTools(server, { root });

    assert.deepEqual([...tools.keys()], ['list_directory', 'read_file', 'write_file', 'edit_file']);
    assert.equal(tools.get('read_file').config.annotations.readOnlyHint, true);
    assert.equal(tools.get('write_file').config.annotations.destructiveHint, false);
    assert.equal(tools.get('edit_file').config.annotations.destructiveHint, true);

    const createResult = await tools.get('write_file').callback({ path: 'new.txt', content: 'hello\n' });
    assert.equal(createResult.isError, undefined);
    assert.equal(createResult.structuredContent.created, true);
    assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), 'hello\n');

    const duplicateResult = await tools.get('write_file').callback({ path: 'new.txt', content: 'again' });
    assert.equal(duplicateResult.isError, true);
    assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), 'hello\n');

    const readResult = await tools.get('read_file').callback({ path: 'sample.txt' });
    assert.equal(readResult.isError, undefined);
    assert.equal(readResult.structuredContent.content, 'alpha\nbeta\n');

    const editResult = await tools.get('edit_file').callback({
      path: 'sample.txt',
      operation: 'replace_lines',
      startLine: 2,
      endLine: 2,
      lines: ['BETA']
    });
    assert.equal(editResult.isError, undefined);
    assert.equal(await readFile(path.join(root, 'sample.txt'), 'utf8'), 'alpha\nBETA\n');
  });
});
