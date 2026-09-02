import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { resolveSafePath } from '../security/path.js';

export const MAX_OUTPUT_BYTES = 256 * 1024;
export const MAX_TIMEOUT_MS = 60_000;

const RESTRICTED_COMMANDS = new Set(['git', 'npm', 'pnpm', 'yarn']);
const TERMINATION_GRACE_MS = 750;
const STOP_ALL_TIMEOUT_MS = 1500;
const FORCE_STOP_TIMEOUT_MS = 750;
const TASKKILL_WATCHDOG_MS = 250;

function compactArgs(args) {
  const shown = args.slice(0, 12).map((arg) => arg.length <= 160 ? arg : `${arg.slice(0, 160)}…<${arg.length - 160} more chars>`);
  if (args.length > shown.length) shown.push(`<${args.length - shown.length} more args>`);
  return shown;
}

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

export function validateCommandPolicy(command, args, { fullAccess = false, allowCustomCommand = false } = {}) {
  validateExecutableName(command);
  if (fullAccess || allowCustomCommand) return;
  if (!RESTRICTED_COMMANDS.has(command)) {
    throw new Error(`Command is not allowed in restricted mode: ${command}`);
  }
  validateRestrictedArgs(command, args);
}

function resolveExecutable(command) {
  if (process.platform === 'win32' && ['npm', 'npx', 'pnpm', 'yarn'].includes(command)) {
    return `${command}.cmd`;
  }
  return command;
}

function childExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function fallbackChildSignal(child, signal) {
  if (childExited(child)) return false;
  try { return child.kill(signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'); } catch { return false; }
}

function signalProcessTree(child, signal = 'SIGTERM') {
  if (childExited(child) || !child.pid) return false;

  if (process.platform === 'win32') {
    try {
      const args = ['/pid', String(child.pid), '/t'];
      if (signal === 'SIGKILL') args.push('/f');
      const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true, shell: false });
      let finished = false;
      const fallback = () => {
        if (finished) return;
        finished = true;
        if (signal !== 'SIGKILL') signalProcessTree(child, 'SIGKILL');
        else fallbackChildSignal(child, signal);
      };
      killer.once('error', fallback);
      killer.once('close', (code) => {
        if (code === 0) {
          finished = true;
          return;
        }
        fallback();
      });
      const watchdog = setTimeout(() => {
        try { killer.kill(); } catch {}
        fallback();
      }, TASKKILL_WATCHDOG_MS);
      watchdog.unref?.();
      killer.unref();
      return true;
    } catch {
      return fallbackChildSignal(child, signal);
    }
  }

  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return fallbackChildSignal(child, signal);
  }
}

function waitWithTimeout(promise, timeoutMs) {
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    })
  ]);
}

function executeFile(executable, args, options, { requestId, register, unregister }) {
  let handle;
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    let cancellationError = null;
    let outputError = null;
    let forceTimer = null;
    let timeoutTimer = null;
    let settled = false;

    const terminate = ({ force = false } = {}) => {
      if (childExited(child)) return;
      if (force) {
        clearTimeout(forceTimer);
        forceTimer = null;
        signalProcessTree(child, 'SIGKILL');
        return;
      }
      signalProcessTree(child, 'SIGTERM');
      if (!forceTimer) {
        forceTimer = setTimeout(() => {
          forceTimer = null;
          if (!childExited(child)) signalProcessTree(child, 'SIGKILL');
        }, TERMINATION_GRACE_MS);
        forceTimer.unref?.();
      }
    };

    const cancel = (error, { force = false } = {}) => {
      if (settled || childExited(child)) return false;
      cancellationError = cancellationError ?? error ?? new Error('Command was cancelled.');
      terminate({ force });
      return true;
    };

    handle = {
      child,
      cancel,
      wait: () => exited
    };
    register(requestId, handle);

    const appendOutput = (chunk, stream) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const currentBytes = stream === 'stdout' ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - currentBytes);
      if (remaining > 0) {
        const stored = remaining >= buffer.byteLength ? buffer : buffer.subarray(0, remaining);
        if (stream === 'stdout') stdoutChunks.push(stored);
        else stderrChunks.push(stored);
      }
      if (stream === 'stdout') stdoutBytes += buffer.byteLength;
      else stderrBytes += buffer.byteLength;
      if (currentBytes + buffer.byteLength > MAX_OUTPUT_BYTES && !outputError) {
        outputError = new Error(`${stream} exceeded the ${MAX_OUTPUT_BYTES}-byte limit.`);
        terminate();
      }
    };

    child.stdout?.on('data', (chunk) => appendOutput(chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => appendOutput(chunk, 'stderr'));

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceTimer);
      unregister(requestId, handle);
      resolveExit();
      reject(new Error(`Failed to start ${executable}: ${error.message}`));
    });

    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceTimer);
      unregister(requestId, handle);
      resolveExit();

      if (cancellationError) {
        reject(cancellationError);
        return;
      }
      if (outputError) {
        reject(outputError);
        return;
      }

      resolve({
        exitCode: typeof code === 'number' ? code : signal ? 1 : 0,
        signal: signal ?? null,
        timedOut,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      });
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeoutTimer.unref?.();
  });
}

export function createCommandService({ root, fullAccess = false }) {
  const active = new Map();

  const register = (requestId, handle) => {
    if (requestId) active.set(requestId, handle);
  };
  const unregister = (requestId, handle) => {
    if (requestId && active.get(requestId) === handle) active.delete(requestId);
  };

  async function runCommand({ command, args = [], cwd = '.', timeoutMs = 15_000 }, context = {}) {
    validateCommandPolicy(command, args, { fullAccess, allowCustomCommand: context.allowCustomCommand });

    const resolvedCwd = context.pathInfo?.resolved ?? await resolveSafePath(root, cwd);
    context.throwIfCancelled?.();
    const cwdStat = await stat(resolvedCwd);
    if (!cwdStat.isDirectory()) throw new Error('cwd must be a directory.');
    context.throwIfCancelled?.();

    context.eventBus?.emit('process.started', {
      requestId: context.requestId,
      command,
      args: compactArgs(args),
      cwd: resolvedCwd,
      sandboxed: false
    });

    const execution = await executeFile(resolveExecutable(command), args, {
      cwd: resolvedCwd,
      timeoutMs
    }, {
      requestId: context.requestId,
      register,
      unregister
    });

    context.eventBus?.emit('process.completed', {
      requestId: context.requestId,
      command,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut
    });

    return {
      command,
      args,
      cwd: path.relative(root, resolvedCwd) || '.',
      mode: fullAccess ? 'full_access' : context.allowCustomCommand ? 'custom_rule' : 'restricted',
      ...execution
    };
  }

  runCommand.cancel = (requestId, error, options = {}) => active.get(requestId)?.cancel(error, options) ?? false;
  runCommand.stopAll = async (error = new Error('Agent is shutting down.'), { force = false } = {}) => {
    const handles = [...active.values()];
    if (!handles.length) return true;

    for (const handle of handles) handle.cancel(error, { force });
    const allExited = Promise.all(handles.map((handle) => handle.wait()));
    const stopped = await waitWithTimeout(allExited, force ? FORCE_STOP_TIMEOUT_MS : STOP_ALL_TIMEOUT_MS);
    if (stopped) return true;

    for (const handle of handles) handle.cancel(error, { force: true });
    return waitWithTimeout(allExited, FORCE_STOP_TIMEOUT_MS);
  };
  runCommand.getActiveRequestIds = () => [...active.keys()];

  return runCommand;
}

export const commandLimits = {
  restrictedCommands: [...RESTRICTED_COMMANDS],
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxTimeoutMs: MAX_TIMEOUT_MS
};
