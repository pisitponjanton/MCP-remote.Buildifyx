#!/usr/bin/env node

import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { startMcpServer } from './server.js';

function printHelp() {
  console.log(`buildifyx-agent

Usage:
  buildifyx-agent remote [--root <path>] [--port <number>]
  buildifyx-agent doctor [--root <path>]
  buildifyx-agent help

Commands:
  remote   Start a private, root-scoped MCP HTTP server on 127.0.0.1
  doctor   Check Node.js and root-directory access

Options:
  --root   Directory ChatGPT is allowed to read and edit (default: current directory)
  --port   Local MCP port (default: 3333)

Example:
  buildifyx-agent remote --root ~/projects --port 3333
`);
}

function getOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

async function resolveRoot(input) {
  const candidate = path.resolve(input ?? process.cwd());
  await access(candidate);
  return realpath(candidate);
}

async function runDoctor(args) {
  const root = await resolveRoot(getOption(args, '--root', process.cwd()));
  console.log('Buildifyx Desktop Agent doctor');
  console.log(`Node:     ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Root:     ${root}`);
  console.log('Status:   OK');
}

async function runRemote(args) {
  const root = await resolveRoot(getOption(args, '--root', process.cwd()));
  const rawPort = getOption(args, '--port', '3333');
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${rawPort}`);
  }

  await startMcpServer({ root, port });
}

async function main() {
  const [, , command = 'help', ...args] = process.argv;

  switch (command) {
    case 'remote':
      await runRemote(args);
      break;
    case 'doctor':
      await runDoctor(args);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      printHelp();
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
