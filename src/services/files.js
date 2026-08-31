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

function displayPath(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : target;
}

async function existingTarget(root, input, context) {
  return context.pathInfo?.resolved ?? resolveSafePath(root, input.path ?? '.');
}

async function newTarget(root, input, context) {
  return context.pathInfo?.resolved ?? resolveSafeNewFilePath(root, input.path);
}

export function createFileServices({ root }) {
  return {
    async list_directory(input = {}, context = {}) {
      const target = await existingTarget(root, input, context);
      const targetStat = await stat(target);
      if (!targetStat.isDirectory()) throw new Error('The requested path is not a directory.');

      const dirents = await readdir(target, { withFileTypes: true });
      const limit = input.limit ?? 200;
      const entries = dirents.slice(0, limit).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
        path: displayPath(root, path.join(target, entry.name))
      }));

      context.eventBus?.emit('resource.accessed', { requestId: context.requestId, resourceType: 'directory', operation: 'list', path: target });
      return {
        path: displayPath(root, target),
        scope: context.pathInfo?.scope ?? 'root',
        total: dirents.length,
        returned: entries.length,
        truncated: dirents.length > entries.length,
        entries
      };
    },

    async read_file(input, context = {}) {
      const target = await existingTarget(root, input, context);
      const content = await readUtf8File(target);
      context.eventBus?.emit('resource.accessed', { requestId: context.requestId, resourceType: 'file', operation: 'read', path: target });
      return {
        path: displayPath(root, target),
        scope: context.pathInfo?.scope ?? 'root',
        size: Buffer.byteLength(content, 'utf8'),
        lineCount: countTextLines(content),
        content
      };
    },

    async write_file(input, context = {}) {
      const target = await newTarget(root, input, context);
      await createUtf8File(target, input.content);
      context.eventBus?.emit('resource.accessed', { requestId: context.requestId, resourceType: 'file', operation: 'create', path: target });
      return {
        path: displayPath(root, target),
        scope: context.pathInfo?.scope ?? 'root',
        created: true,
        size: Buffer.byteLength(input.content, 'utf8'),
        lineCount: countTextLines(input.content)
      };
    },

    async edit_file(input, context = {}) {
      const target = await existingTarget(root, input, context);
      const previousContent = await readUtf8File(target);
      let nextContent;
      switch (input.operation) {
        case 'overwrite': nextContent = input.content; break;
        case 'replace_lines': nextContent = replaceLines(previousContent, input.startLine, input.endLine, input.lines); break;
        case 'replace_characters': nextContent = replaceCharacters(previousContent, input.start, input.end, input.content); break;
        default: throw new Error(`Unsupported edit operation: ${input.operation}`);
      }
      const changed = nextContent !== previousContent;
      if (changed) await writeUtf8FileAtomic(target, nextContent);
      context.eventBus?.emit('resource.accessed', { requestId: context.requestId, resourceType: 'file', operation: 'write', path: target, changed });
      return {
        path: displayPath(root, target),
        scope: context.pathInfo?.scope ?? 'root',
        operation: input.operation,
        changed,
        size: Buffer.byteLength(nextContent, 'utf8'),
        lineCount: countTextLines(nextContent)
      };
    }
  };
}
