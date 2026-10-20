// execFile('npm', ...) works on POSIX, but Windows npm is normally npm.cmd.
// Invoke the shipped npm-cli.js via node.exe instead of enabling a shell.
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

export function npmInvocation(args, {
  platform = process.platform,
  execPath = process.execPath,
  npmExecPath = process.env.npm_execpath,
  fileExists = existsSync
} = {}) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) {
    throw new TypeError('npm arguments must be strings.');
  }
  if (platform !== 'win32') return { command: 'npm', args: [...args] };
  const windows = path.win32;
  const bundled = windows.join(windows.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const candidates = [bundled];
  if (typeof npmExecPath === 'string' && windows.isAbsolute(npmExecPath)
    && windows.basename(npmExecPath).toLowerCase() === 'npm-cli.js') {
    candidates.push(npmExecPath);
  }
  const cli = candidates.find(candidate => fileExists(candidate));
  if (!cli) throw new Error('npm-cli.js not found alongside node.exe; cannot safely run Windows npm without a shell.');
  return { command: execPath, args: [cli, ...args] };
}
