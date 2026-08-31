import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveSafeNewFilePath, resolveSafePath } from '../../src/security/path.js';
import { createFileServices } from '../../src/services/files.js';
import { MAX_TEXT_FILE_BYTES, countTextLines, readUtf8File, replaceCharacters, replaceLines, writeUtf8FileAtomic } from '../../src/utils/text.js';

async function withTemp(callback) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-files-')));
  try { return await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('text helpers preserve line endings and unicode positions', () => {
  assert.equal(countTextLines('one\r\ntwo\r\n'), 3);
  assert.equal(replaceLines('one\ntwo\n', 2, 2, ['TWO']), 'one\nTWO\n');
  assert.equal(replaceCharacters('A😀B', { line: 1, column: 2 }, { line: 1, column: 3 }, 'X'), 'AXB');
});

test('safe paths reject traversal and symlink escapes', async () => {
  await withTemp(async (base) => {
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    await mkdir(root); await mkdir(outside);
    await writeFile(path.join(root, 'safe.txt'), 'safe');
    await symlink(path.join(outside), path.join(root, 'external'));
    await assert.rejects(resolveSafePath(root, '../outside'), /outside the allowed root/);
    await assert.rejects(resolveSafeNewFilePath(root, 'external/new.txt'), /outside/);
  });
});

test('file services list, read, create and edit files', async () => {
  await withTemp(async (root) => {
    await writeFile(path.join(root, 'sample.txt'), 'alpha\nbeta\n');
    const files = createFileServices({ root });
    const listing = await files.list_directory({ path: '.' });
    assert.equal(listing.entries.some((entry) => entry.name === 'sample.txt'), true);
    assert.equal((await files.read_file({ path: 'sample.txt' })).content, 'alpha\nbeta\n');
    await files.write_file({ path: 'new.txt', content: 'hello\n' });
    await files.edit_file({ path: 'sample.txt', operation: 'replace_lines', startLine: 2, endLine: 2, lines: ['BETA'] });
    assert.equal(await readFile(path.join(root, 'sample.txt'), 'utf8'), 'alpha\nBETA\n');
  });
});

test('UTF-8 and atomic writes enforce size and preserve permissions', async () => {
  await withTemp(async (root) => {
    const file = path.join(root, 'editable.txt');
    await writeFile(file, 'before'); await chmod(file, 0o640);
    await writeUtf8FileAtomic(file, 'after');
    assert.equal((await lstat(file)).mode & 0o777, 0o640);
    await assert.rejects(writeUtf8FileAtomic(file, 'x'.repeat(MAX_TEXT_FILE_BYTES + 1)), /exceeds/);
    await writeFile(path.join(root, 'binary.dat'), Buffer.from([0xff, 0xfe]));
    await assert.rejects(readUtf8File(path.join(root, 'binary.dat')), /not valid UTF-8/);
  });
});
