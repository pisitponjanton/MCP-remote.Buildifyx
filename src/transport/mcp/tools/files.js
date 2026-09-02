import * as z from 'zod/v4';
import { MAX_TEXT_FILE_BYTES } from '../../../services/files.js';

const FilePath = z.string().min(1).max(4096).describe('Path relative to the configured root directory.');
const TextContent = z.string().max(MAX_TEXT_FILE_BYTES);

const schemas = {
  list_directory: z.object({
    path: z.string().max(4096).default('.').describe('Path relative to the configured root directory.'),
    limit: z.number().int().min(1).max(500).default(200)
  }),
  read_file: z.object({ path: FilePath }),
  write_file: z.object({ path: FilePath, content: TextContent }),
  edit_file: z.discriminatedUnion('operation', [
    z.object({ path: FilePath, operation: z.literal('overwrite'), content: TextContent }),
    z.object({ path: FilePath, operation: z.literal('replace_lines'), startLine: z.number().int().min(1), endLine: z.number().int().min(1), lines: z.array(z.string().max(65_536)).max(10_000) }),
    z.object({ path: FilePath, operation: z.literal('replace_characters'), start: z.object({ line: z.number().int().min(1), column: z.number().int().min(1) }), end: z.object({ line: z.number().int().min(1), column: z.number().int().min(1) }), content: TextContent })
  ])
};

export function getFileToolDefinitions() {
  return [
    {
      name: 'list_directory',
      title: 'List directory',
      description: 'List files and folders inside the configured root directory.',
      permission: 'read',
      inputSchema: schemas.list_directory,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    {
      name: 'read_file',
      title: 'Read file',
      description: `Read one UTF-8 text file inside the configured root. Files are limited to ${MAX_TEXT_FILE_BYTES} bytes.`,
      permission: 'read',
      inputSchema: schemas.read_file,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    {
      name: 'write_file',
      title: 'Write file',
      description: 'Create one new UTF-8 text file inside the configured root. Existing files are never overwritten.',
      permission: 'write',
      inputSchema: schemas.write_file,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    {
      name: 'edit_file',
      title: 'Edit file',
      description: 'Edit an existing UTF-8 text file inside the configured root.',
      permission: 'write',
      inputSchema: schemas.edit_file,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    }
  ];
}
