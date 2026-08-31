import { constants } from 'node:fs';
import { access, open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

export const MAX_TEXT_FILE_BYTES = 1024 * 1024;

const utf8Decoder = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: true
});

export async function readUtf8File(filePath) {
  const fileStat = await stat(filePath);

  if (!fileStat.isFile()) {
    throw new Error('The requested path is not a regular file.');
  }
  if (fileStat.size > MAX_TEXT_FILE_BYTES) {
    throw new Error(`File exceeds the ${MAX_TEXT_FILE_BYTES}-byte limit.`);
  }

  const handle = await open(filePath, 'r');
  try {
    const buffer = await handle.readFile();
    if (buffer.byteLength > MAX_TEXT_FILE_BYTES) {
      throw new Error(`File exceeds the ${MAX_TEXT_FILE_BYTES}-byte limit.`);
    }

    try {
      return utf8Decoder.decode(buffer);
    } catch {
      throw new Error('The requested file is not valid UTF-8 text.');
    }
  } finally {
    await handle.close();
  }
}

function getLines(content) {
  const lines = [];
  const newlinePattern = /\r\n|\n|\r/g;
  let start = 0;
  let match;

  while ((match = newlinePattern.exec(content)) !== null) {
    lines.push({
      start,
      contentEnd: match.index,
      end: newlinePattern.lastIndex,
      separator: match[0]
    });
    start = newlinePattern.lastIndex;
  }

  lines.push({ start, contentEnd: content.length, end: content.length, separator: '' });
  return lines;
}

export function countTextLines(content) {
  return getLines(content).length;
}

function assertLineNumber(lines, line, label) {
  if (line < 1 || line > lines.length) {
    throw new Error(`${label} must be between 1 and ${lines.length}.`);
  }
}

export function replaceLines(content, startLine, endLine, replacementLines) {
  const lines = getLines(content);
  assertLineNumber(lines, startLine, 'startLine');
  assertLineNumber(lines, endLine, 'endLine');

  if (endLine < startLine) {
    throw new Error('endLine must be greater than or equal to startLine.');
  }
  if (replacementLines.some((line) => /[\r\n]/.test(line))) {
    throw new Error('Each replacement line must not contain newline characters.');
  }

  const first = lines[startLine - 1];
  const last = lines[endLine - 1];
  const preferredSeparator = lines.find((line) => line.separator)?.separator ?? '\n';
  let replacement = replacementLines.join(preferredSeparator);

  if (replacementLines.length > 0 && last.separator) {
    replacement += last.separator;
  }

  return content.slice(0, first.start) + replacement + content.slice(last.end);
}

function characterOffset(content, position, label) {
  const lines = getLines(content);
  assertLineNumber(lines, position.line, `${label}.line`);

  const selectedLine = lines[position.line - 1];
  const lineContent = content.slice(selectedLine.start, selectedLine.contentEnd);
  const characters = Array.from(lineContent);
  const maxColumn = characters.length + 1;

  if (position.column < 1 || position.column > maxColumn) {
    throw new Error(`${label}.column must be between 1 and ${maxColumn}.`);
  }

  return selectedLine.start + characters.slice(0, position.column - 1).join('').length;
}

export function replaceCharacters(content, start, end, replacement) {
  const startOffset = characterOffset(content, start, 'start');
  const endOffset = characterOffset(content, end, 'end');

  if (endOffset < startOffset) {
    throw new Error('The end position must not come before the start position.');
  }

  return content.slice(0, startOffset) + replacement + content.slice(endOffset);
}

export async function createUtf8File(filePath, content) {
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > MAX_TEXT_FILE_BYTES) {
    throw new Error(`File exceeds the ${MAX_TEXT_FILE_BYTES}-byte limit.`);
  }

  let handle;
  try {
    handle = await open(filePath, 'wx', 0o644);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EEXIST') {
      throw new Error('File already exists.');
    }
    throw error;
  } finally {
    if (handle) {
      await handle.close();
    }
  }
}

export async function writeUtf8FileAtomic(filePath, content) {
  const byteLength = Buffer.byteLength(content, 'utf8');
  if (byteLength > MAX_TEXT_FILE_BYTES) {
    throw new Error(`Edited file exceeds the ${MAX_TEXT_FILE_BYTES}-byte limit.`);
  }

  const originalStat = await stat(filePath);
  if (!originalStat.isFile()) {
    throw new Error('The requested path is not a regular file.');
  }
  await access(filePath, constants.W_OK);

  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const temporaryPath = path.join(directory, `.${basename}.buildifyx-${process.pid}-${randomUUID()}.tmp`);
  let temporaryCreated = false;

  try {
    const handle = await open(temporaryPath, 'wx', originalStat.mode);
    temporaryCreated = true;
    try {
      await handle.writeFile(content, 'utf8');
      await handle.chmod(originalStat.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temporaryPath, filePath);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
