import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export function getOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}

export function hasFlag(args, name) {
  return args.includes(name);
}

export async function resolveRoot(input = process.cwd()) {
  const candidate = path.resolve(input);
  await access(candidate);
  return realpath(candidate);
}

export function parsePort(value = '3333') {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${value}`);
  return port;
}

export function parseInvocation(argv) {
  const first = argv[0];
  const cloudFlags = new Set(['--root', '--unrestricted-commands', '--full-access', '--no-tui']);
  if (!first || cloudFlags.has(first)) return { command: 'cloud', args: argv };
  return { command: first, args: argv.slice(1) };
}
