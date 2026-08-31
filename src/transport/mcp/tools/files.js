import * as z from 'zod/v4';
import { MAX_TEXT_FILE_BYTES } from '../../../services/files.js';
import { errorResult, successResult } from '../response.js';

const FilePath = z.string().min(1).describe('Path relative to the configured root directory.');

const schemas = {
  list_directory: z.object({
    path: z.string().default('.').describe('Path relative to the configured root directory.'),
    limit: z.number().int().min(1).max(500).default(200)
  }),
  read_file: z.object({ path: FilePath }),
  write_file: z.object({ path: FilePath, content: z.string() }),
  edit_file: z.discriminatedUnion('operation', [
    z.object({ path: FilePath, operation: z.literal('overwrite'), content: z.string() }),
    z.object({ path: FilePath, operation: z.literal('replace_lines'), startLine: z.number().int().min(1), endLine: z.number().int().min(1), lines: z.array(z.string()) }),
    z.object({ path: FilePath, operation: z.literal('replace_characters'), start: z.object({ line: z.number().int().min(1), column: z.number().int().min(1) }), end: z.object({ line: z.number().int().min(1), column: z.number().int().min(1) }), content: z.string() })
  ])
};

export function registerFileTools(server, dispatch) {
  const definitions = [
    ['list_directory', 'List directory', 'List files and folders inside the configured root directory.', { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
    ['read_file', 'Read file', `Read one UTF-8 text file inside the configured root. Files are limited to ${MAX_TEXT_FILE_BYTES} bytes.`, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
    ['write_file', 'Write file', `Create one new UTF-8 text file inside the configured root. Existing files are never overwritten.`, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
    ['edit_file', 'Edit file', 'Edit an existing UTF-8 text file inside the configured root.', { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }]
  ];

  for (const [name, title, description, annotations] of definitions) {
    server.registerTool(name, { title, description, inputSchema: schemas[name], annotations }, async (input) => {
      try {
        return successResult(await dispatch(name, input));
      } catch (error) {
        return errorResult(error);
      }
    });
  }
}
