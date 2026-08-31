import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveSafeNewFilePath, resolveSafePath } from '../security/path.js';
import {
  MAX_TEXT_FILE_BYTES,
  countTextLines,
  createUtf8File,
  readUtf8File,
  replaceCharacters,
  replaceLines,
  writeUtf8FileAtomic
} from '../utils/text.js';

export { MAX_TEXT_FILE_BYTES } from '../utils/text.js';

export function createFileServices({ root }) {
  return {
    async list_directory({ path: requestedPath = '.', limit = 200 } = {}) {
      const target = await resolveSafePath(root, requestedPath);
      const targetStat = await stat(target);
      if (!targetStat.isDirectory()) throw new Error('The requested path is not a directory.');

      const dirents = await readdir(target, { withFileTypes: true });
      const entries = dirents.slice(0, limit).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
        path: path.relative(root, path.join(target, entry.name)) || '.'
      }));

      return {
        path: path.relative(root, target) || '.',
        total: dirents.length,
        returned: entries.length,
        truncated: dirents.length > entries.length,
        entries
      };
    },

    async read_file({ path: requestedPath }) {
      const target = await resolveSafePath(root, requestedPath);
      const content = await readUtf8File(target);
      return {
        path: path.relative(root, target) || '.',
        size: Buffer.byteLength(content, 'utf8'),
        lineCount: countTextLines(content),
        content
      };
    },

    async write_file({ path: requestedPath, content }) {
      const target = await resolveSafeNewFilePath(root, requestedPath);
      await createUtf8File(target, content);
      return {
        path: path.relative(root, target) || '.',
        created: true,
        size: Buffer.byteLength(content, 'utf8'),
        lineCount: countTextLines(content)
      };
    },

    async edit_file(input) {
      const target = await resolveSafePath(root, input.path);
      const previousContent = await readUtf8File(target);
      let nextContent;

      switch (input.operation) {
        case 'overwrite':
          nextContent = input.content;
          break;
        case 'replace_lines':
          nextContent = replaceLines(previousContent, input.startLine, input.endLine, input.lines);
          break;
        case 'replace_characters':
          nextContent = replaceCharacters(previousContent, input.start, input.end, input.content);
          break;
        default:
          throw new Error(`Unsupported edit operation: ${input.operation}`);
      }

      const changed = nextContent !== previousContent;
      if (changed) await writeUtf8FileAtomic(target, nextContent);

      return {
        path: path.relative(root, target) || '.',
        operation: input.operation,
        changed,
        size: Buffer.byteLength(nextContent, 'utf8'),
        lineCount: countTextLines(nextContent)
      };
    }
  };
}
