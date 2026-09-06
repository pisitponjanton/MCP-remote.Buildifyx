import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveSafeNewFilePath, resolveSafePath } from '../../src/security/path.js';
import { classifyPath } from '../../src/security/scope.js';
import { createFileServices } from '../../src/services/files.js';
import { MAX_TEXT_FILE_BYTES, countTextLines, readUtf8File, replaceCharacters, replaceLines, sliceTextLines, writeUtf8FileAtomic } from '../../src/utils/text.js';

async function withTemp(callback) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-files-')));
  try { return await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('text helpers preserve line endings and unicode positions', () => {
  assert.equal(countTextLines('one\r\ntwo\r\n'), 3);
  assert.equal(countTextLines(''), 1);
  assert.equal(replaceLines('one\ntwo\n', 2, 2, ['TWO']), 'one\nTWO\n');
  assert.equal(replaceLines('one\ntwo\n', 3, 3, ['three']), 'one\ntwo\nthree');
  assert.equal(replaceCharacters('one\ntwo\n', { line: 3, column: 1 }, { line: 3, column: 1 }, 'three'), 'one\ntwo\nthree');
  assert.equal(replaceCharacters('A😀B', { line: 1, column: 2 }, { line: 1, column: 3 }, 'X'), 'AXB');
});

test('text line ranges preserve line endings and report continuation metadata', () => {
  const content = 'one\r\ntwo\r\nสาม\r\nfour\r\nfive';
  assert.deepEqual(sliceTextLines(content, 2, 4), {
    content: 'two\r\nสาม\r\nfour\r\n',
    lineCount: 5,
    startLine: 2,
    endLine: 4,
    returnedLineCount: 3,
    truncated: true,
    nextStartLine: 5
  });
  assert.equal(sliceTextLines(content, 4, 99).content, 'four\r\nfive');
  assert.deepEqual(sliceTextLines('one\ntwo\n', 2, 99), {
    content: 'two\n',
    lineCount: 3,
    startLine: 2,
    endLine: 3,
    returnedLineCount: 2,
    truncated: true,
    nextStartLine: null
  });
  assert.equal(sliceTextLines('one\ntwo\n', 3, 3).content, '');
  assert.throws(() => sliceTextLines(content, 4, 3), /greater than or equal/);
  assert.throws(() => sliceTextLines(content, 6, 6), /between 1 and 5/);
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

test('MCP file and scope resolution always protect Buildifyx internal state', async () => {
  await withTemp(async (base) => {
    const internal = path.join(base, '.buildifyx');
    await mkdir(internal);
    await writeFile(path.join(internal, 'credentials.json'), 'secret');
    const previous = process.env.BUILDFYX_HOME;
    process.env.BUILDFYX_HOME = internal;
    try {
      await assert.rejects(
        resolveSafePath(base, path.join(internal, 'credentials.json')),
        /Buildifyx internal state/
      );
      await assert.rejects(
        resolveSafeNewFilePath(base, path.join(internal, 'new.json')),
        /Buildifyx internal state/
      );
      await assert.rejects(
        classifyPath({ root: base, additionalRoots: [base], userPath: path.join(internal, 'credentials.json') }),
        /Buildifyx internal state/
      );
    } finally {
      if (previous === undefined) delete process.env.BUILDFYX_HOME;
      else process.env.BUILDFYX_HOME = previous;
    }
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

test('read_file supports optional line ranges while preserving full-read compatibility', async () => {
  await withTemp(async (root) => {
    const content = 'one\r\ntwo\r\nสาม\r\nfour\r\nfive';
    await writeFile(path.join(root, 'long.md'), content);
    const files = createFileServices({ root });

    const full = await files.read_file({ path: 'long.md' });
    assert.deepEqual(Object.keys(full).sort(), ['content', 'lineCount', 'path', 'scope', 'size']);
    assert.equal(full.content, content);
    assert.equal(full.lineCount, 5);

    await writeFile(path.join(root, 'trailing.md'), 'one\ntwo\n');
    const legacyFull = await files.read_file({ path: 'trailing.md' });
    assert.equal(legacyFull.lineCount, 3);
    assert.equal('startLine' in legacyFull, false);
    const rangedTrailing = await files.read_file({ path: 'trailing.md', startLine: 1, endLine: 99 });
    assert.equal(rangedTrailing.lineCount, 3);
    assert.equal(rangedTrailing.endLine, 3);
    assert.equal(rangedTrailing.returnedLineCount, 3);
    assert.equal(rangedTrailing.truncated, false);
    assert.equal(rangedTrailing.nextStartLine, null);
    const trailingEmpty = await files.read_file({ path: 'trailing.md', startLine: 3, endLine: 3 });
    assert.equal(trailingEmpty.content, '');
    assert.equal(trailingEmpty.lineCount, legacyFull.lineCount);

    const middle = await files.read_file({ path: 'long.md', startLine: 2, endLine: 4 });
    assert.equal(middle.content, 'two\r\nสาม\r\nfour\r\n');
    assert.equal(middle.lineCount, 5);
    assert.equal(middle.startLine, 2);
    assert.equal(middle.endLine, 4);
    assert.equal(middle.returnedLineCount, 3);
    assert.equal(middle.truncated, true);
    assert.equal(middle.nextStartLine, 5);

    const throughEof = await files.read_file({ path: 'long.md', startLine: 4, endLine: 99 });
    assert.equal(throughEof.content, 'four\r\nfive');
    assert.equal(throughEof.endLine, 5);
    assert.equal(throughEof.nextStartLine, null);

    await assert.rejects(files.read_file({ path: 'long.md', startLine: 4, endLine: 3 }), /greater than or equal/);
    await assert.rejects(files.read_file({ path: 'long.md', startLine: 6, endLine: 6 }), /between 1 and 5/);
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

test('atomic edits can abort at the commit point without changing the target', async () => {
  await withTemp(async (root) => {
    const file = path.join(root, 'commit.txt');
    await writeFile(file, 'before');
    await assert.rejects(
      writeUtf8FileAtomic(file, 'after', { beforeCommit: () => { throw new Error('cancel before commit'); } }),
      /cancel before commit/
    );
    assert.equal(await readFile(file, 'utf8'), 'before');
    assert.equal((await readdir(root)).some((name) => name.includes('.buildifyx-') && name.endsWith('.tmp')), false);
  });
});
