import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { resolveSafePath } from '../security/path.js';

export const MAX_OUTPUT_BYTES = 256 * 1024;
export const MAX_TIMEOUT_MS = 60_000;

const RESTRICTED_COMMANDS = new Set(['git', 'npm', 'pnpm', 'yarn']);
const FULL_ACCESS_COMMANDS = new Set([
  ...RESTRICTED_COMMANDS,
  'node',
  'npx',
  'bun',
  'deno',
  'python',
  'python3',
  'pip',
  'pip3'
]);

function validateExecutableName(command) {
  if (command.includes('/') || command.includes('\\') || path.basename(command) !== command) {
    throw new Error('Command must be an executable name, not a path.');
  }
}

function validateRestrictedArgs(command, args) {
  if (command === 'npm' && (args[0] === 'exec' || args[0] === 'x')) {
    throw new Error('npm exec is not allowed in restricted mode.');
  }
  if ((command === 'pnpm' || command === 'yarn') && (args[0] === 'dlx' || args[0] === 'exec')) {
    throw new Error(`${command} ${args[0]} is not allowed in restricted mode.`);
  }
}

export function validateCommandPolicy(command, args, { fullAccess = false } = {}) {
  validateExecutableName(command);
  const allowedCommands = fullAccess ? FULL_ACCESS_COMMANDS : RESTRICTED_COMMANDS;
  if (!allowedCommands.has(command)) {
    throw new Error(
      fullAccess
        ? `Command is not allowed. Allowed commands: ${[...FULL_ACCESS_COMMANDS].join(', ')}`
        : `Command is not allowed in restricted mode. Allowed commands: ${[...RESTRICTED_COMMANDS].join(', ')}`
    );
  }
  if (!fullAccess) validateRestrictedArgs(command, args);
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

export function createCommandService({ root, fullAccess = false }) {
  return async function runCommand({ command, args = [], cwd = '.', timeoutMs = 15_000 }) {
    validateCommandPolicy(command, args, { fullAccess });

    const resolvedCwd = await resolveSafePath(root, cwd);
    const cwdStat = await stat(resolvedCwd);
    if (!cwdStat.isDirectory()) {
      throw new Error('cwd must be a directory.');
    }

    return {
      command,
      args,
      cwd: path.relative(root, resolvedCwd) || '.',
      mode: fullAccess ? 'full_access' : 'restricted',
      ...(await executeFile(resolveExecutable(command), args, {
        cwd: resolvedCwd,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        encoding: 'utf8',
        shell: false
      }))
    };
  };
}

export const commandLimits = {
  restrictedCommands: [...RESTRICTED_COMMANDS],
  fullAccessCommands: [...FULL_ACCESS_COMMANDS],
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxTimeoutMs: MAX_TIMEOUT_MS
};
