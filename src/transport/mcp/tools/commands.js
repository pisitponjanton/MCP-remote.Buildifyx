import * as z from 'zod/v4';
import { MAX_OUTPUT_BYTES, MAX_TIMEOUT_MS } from '../../../services/commands.js';
import { errorResult, successResult } from '../response.js';

const RunCommandInput = z.object({
  command: z.string().min(1).describe('Allowed executable name. Paths and shell command strings are not accepted.'),
  args: z.array(z.string().max(4096)).max(128).default([]),
  cwd: z.string().default('.').describe('Working directory relative to the configured root directory.'),
  timeoutMs: z.number().int().min(100).max(MAX_TIMEOUT_MS).default(15_000)
});

export function registerCommandTools(server, dispatch, { fullAccess = false } = {}) {
  server.registerTool(
    'run_command',
    {
      title: 'Run command',
      description: fullAccess
        ? `Run an allowlisted command in FULL ACCESS mode. Commands are not sandboxed. Timeout: ${MAX_TIMEOUT_MS} ms; output: ${MAX_OUTPUT_BYTES} bytes per stream.`
        : `Run a restricted developer command without a shell. cwd must stay inside the configured root. Timeout: ${MAX_TIMEOUT_MS} ms; output: ${MAX_OUTPUT_BYTES} bytes per stream.`,
      inputSchema: RunCommandInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async (input) => {
      try {
        const result = await dispatch('run_command', input);
        return successResult(result, { isError: result.exitCode !== 0 || result.timedOut });
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
