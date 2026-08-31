import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import * as z from 'zod/v4';
import { resolveSafePath } from '../security/path.js';

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 60_000;

const ALLOWED_COMMANDS = new Set([
  'git',
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'python',
  'python3',
  'pip',
  'pip3'
]);

const RunCommandInput = z.object({
  command: z.string().min(1).describe('Allowed executable name. Paths and shell command strings are not accepted.'),
  args: z.array(z.string().max(4096)).max(128).default([]).describe('Arguments passed directly to the executable without a shell.'),
  cwd: z.string().default('.').describe('Working directory relative to the configured root directory.'),
  timeoutMs: z.number().int().min(100).max(MAX_TIMEOUT_MS).default(15_000).describe('Command timeout in milliseconds.')
});

function toolError(error) {
  return {
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true
  };
}

function validateCommand(command) {
  if (command.includes('/') || command.includes('\\') || path.basename(command) !== command) {
    throw new Error('Command must be an executable name, not a path.');
  }

  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(`Command is not allowed. Allowed commands: ${[...ALLOWED_COMMANDS].join(', ')}`);
  }
}

function resolveExecutable(command) {
  if (process.platform === 'win32' && ['npm', 'npx', 'pnpm', 'yarn'].includes(command)) {
    return `${command}.cmd`;
  }
  return command;
}

function executeFile(executable, args, options) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, options, (error, stdout, stderr) => {
      if (error && typeof error.code === 'string') {
        reject(new Error(`Failed to start ${executable}: ${error.message}`));
        return;
      }

      resolve({
        exitCode: error && typeof error.code === 'number' ? error.code : 0,
        signal: error?.signal ?? null,
        timedOut: Boolean(error?.killed && error?.signal),
        stdout: stdout ?? '',
        stderr: stderr ?? ''
      });
    });
  });
}

export function registerCommandTools(server, { root }) {
  server.registerTool(
    'run_command',
    {
      title: 'Run command',
      description: `Run an allowlisted developer command without a shell. cwd must stay inside the configured root. Timeout is limited to ${MAX_TIMEOUT_MS} ms and output to ${MAX_OUTPUT_BYTES} bytes per stream.`,
      inputSchema: RunCommandInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ command, args, cwd, timeoutMs }) => {
      try {
        validateCommand(command);

        const resolvedCwd = await resolveSafePath(root, cwd);
        const cwdStat = await stat(resolvedCwd);
        if (!cwdStat.isDirectory()) {
          throw new Error('cwd must be a directory.');
        }

        const result = await executeFile(resolveExecutable(command), args, {
          cwd: resolvedCwd,
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          encoding: 'utf8',
          shell: false
        });

        const structured = {
          command,
          args,
          cwd: path.relative(root, resolvedCwd) || '.',
          ...result
        };

        return {
          content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
          isError: result.exitCode !== 0 || result.timedOut ? true : undefined
        };
      } catch (error) {
        return toolError(error);
      }
    }
  );
}

export const commandLimits = {
  allowedCommands: [...ALLOWED_COMMANDS],
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxTimeoutMs: MAX_TIMEOUT_MS
};
