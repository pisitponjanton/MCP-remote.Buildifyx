import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import { resolveSafeNewFilePath, resolveSafePath } from '../security/path.js';
import {
  MAX_TEXT_FILE_BYTES,
  countTextLines,
  createUtf8File,
  readUtf8File,
  replaceCharacters,
  replaceLines,
  writeUtf8FileAtomic
} from './text.js';

const ListDirectoryInput = z.object({
  path: z.string().default('.').describe('Path relative to the configured root directory.'),
  limit: z.number().int().min(1).max(500).default(200).describe('Maximum number of entries to return.')
});

const FilePath = z.string().min(1).describe('Path relative to the configured root directory.');

const ReadFileInput = z.object({
  path: FilePath
});

const WriteFileInput = z.object({
  path: FilePath,
  content: z.string().describe('UTF-8 text content for the new file.')
});

const Position = z.object({
  line: z.number().int().min(1).describe('One-based line number.'),
  column: z.number().int().min(1).describe('One-based Unicode character column.')
});

const EditFileInput = z.discriminatedUnion('operation', [
  z.object({
    path: FilePath,
    operation: z.literal('overwrite'),
    content: z.string().describe('Complete replacement content for the file.')
  }),
  z.object({
    path: FilePath,
    operation: z.literal('replace_lines'),
    startLine: z.number().int().min(1).describe('First line to replace, inclusive and one-based.'),
    endLine: z.number().int().min(1).describe('Last line to replace, inclusive and one-based.'),
    lines: z.array(z.string()).describe('Replacement lines without newline characters. An empty array deletes the range.')
  }),
  z.object({
    path: FilePath,
    operation: z.literal('replace_characters'),
    start: Position.describe('Inclusive start position.'),
    end: Position.describe('Exclusive end position.'),
    content: z.string().describe('Replacement text. May contain newlines.')
  })
]);

function toolError(error) {
  return {
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true
  };
}

export function registerFileTools(server, { root }) {
  server.registerTool(
    'list_directory',
    {
      title: 'List directory',
      description: 'List files and folders inside the configured root directory. Paths cannot escape the root.',
      inputSchema: ListDirectoryInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ path: requestedPath, limit }) => {
      try {
        const target = await resolveSafePath(root, requestedPath);
        const targetStat = await stat(target);

        if (!targetStat.isDirectory()) {
          return {
            content: [{ type: 'text', text: 'The requested path is not a directory.' }],
            isError: true
          };
        }

        const dirents = await readdir(target, { withFileTypes: true });
        const entries = dirents
          .slice(0, limit)
          .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
            path: path.relative(root, path.join(target, entry.name)) || '.'
          }));

        const result = {
          path: path.relative(root, target) || '.',
          total: dirents.length,
          returned: entries.length,
          truncated: dirents.length > entries.length,
          entries
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'read_file',
    {
      title: 'Read file',
      description: `Read one UTF-8 text file inside the configured root directory. Files are limited to ${MAX_TEXT_FILE_BYTES} bytes.`,
      inputSchema: ReadFileInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ path: requestedPath }) => {
      try {
        const target = await resolveSafePath(root, requestedPath);
        const content = await readUtf8File(target);
        const result = {
          path: path.relative(root, target) || '.',
          size: Buffer.byteLength(content, 'utf8'),
          lineCount: countTextLines(content),
          content
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'write_file',
    {
      title: 'Write file',
      description: `Create one new UTF-8 text file inside the configured root directory. Existing files are never overwritten. Files are limited to ${MAX_TEXT_FILE_BYTES} bytes.`,
      inputSchema: WriteFileInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ path: requestedPath, content }) => {
      try {
        const target = await resolveSafeNewFilePath(root, requestedPath);
        await createUtf8File(target, content);

        const result = {
          path: path.relative(root, target) || '.',
          created: true,
          size: Buffer.byteLength(content, 'utf8'),
          lineCount: countTextLines(content)
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'edit_file',
    {
      title: 'Edit file',
      description: 'Edit an existing UTF-8 text file inside the configured root by overwriting it, replacing lines, or replacing a character range.',
      inputSchema: EditFileInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input) => {
      try {
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
        }

        const changed = nextContent !== previousContent;
        if (changed) {
          await writeUtf8FileAtomic(target, nextContent);
        }

        const result = {
          path: path.relative(root, target) || '.',
          operation: input.operation,
          changed,
          size: Buffer.byteLength(nextContent, 'utf8'),
          lineCount: countTextLines(nextContent)
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
