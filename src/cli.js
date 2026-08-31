#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { startMcpServer } from './server.js';
import { checkForUpdate, getPackageMetadata } from './version.js';

function printHelp() {
  console.log(`bdxa — Buildifyx Desktop Agent

Usage:
  bdxa [command] [options]
  buildifyx-agent [command] [options]

Default:
  Running bdxa with no command starts remote mode.

Commands:
  remote, r   Start the private MCP HTTP server on 127.0.0.1
  doctor, d   Check environment, root access, and package version
  update, u   Update Buildifyx Desktop Agent to the latest npm version
  help        Show this help message

Global options:
  -h, --help       Show help
  -v, --version    Show installed version

Command options:
  --root <path>    Directory ChatGPT is allowed to access (default: current directory)
  --port <number>  Local MCP port for remote mode (default: 3333)

Examples:
  bdxa
  bdxa --root ~/projects
  bdxa r --root ~/projects
  bdxa doctor
  bdxa update
  bdxa -v
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

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { ...options, windowsHide: false }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });

    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
  });
}

async function updatePackage({ name }) {
  console.log(`Updating ${name} to the latest version...`);
  await runProcess(npmExecutable(), ['install', '--global', `${name}@latest`]);
  console.log('Update complete. Run bdxa again to use the latest version.');
}

async function getVersionStatus() {
  const metadata = await getPackageMetadata();
  const result = await checkForUpdate(metadata.name, metadata.version);
  return { ...metadata, ...result };
}

async function maybeOfferUpdate({ skipPrompt = false } = {}) {
  const status = await getVersionStatus();

  if (!status.latestVersion || !status.updateAvailable) {
    return status;
  }

  console.log(`\nUpdate available: ${status.version} → ${status.latestVersion}`);

  if (skipPrompt || !process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`Run: bdxa update`);
    return status;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Update now? (Y/n) ')).trim().toLowerCase();
    if (answer === '' || answer === 'y' || answer === 'yes') {
      await updatePackage(status);
      return { ...status, updated: true };
    }

    console.log('Continuing without updating.');
    return status;
  } finally {
    rl.close();
  }
}

async function printVersion() {
  const status = await getVersionStatus();
  console.log(status.version);
  if (status.latestVersion) {
    console.log(status.updateAvailable ? `Latest: ${status.latestVersion} (update available)` : 'Status: latest');
  }
}

async function runDoctor(args, versionStatus) {
  const root = await resolveRoot(getOption(args, '--root', process.cwd()));
  console.log('Buildifyx Desktop Agent doctor');
  console.log(`Node:     ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Root:     ${root}`);
  console.log(`Version:  ${versionStatus.version}${versionStatus.updateAvailable && versionStatus.latestVersion ? ` (latest: ${versionStatus.latestVersion})` : ' (latest)'}`);
  if (versionStatus.error) {
    console.log(`Registry: unavailable (${versionStatus.error})`);
  }
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

function parseInvocation(argv) {
  const first = argv[0];

  if (!first || first.startsWith('--root') || first.startsWith('--port')) {
    return { command: 'remote', args: argv };
  }

  return { command: first, args: argv.slice(1) };
}

async function main() {
  const argv = process.argv.slice(2);
  const { command, args } = parseInvocation(argv);

  if (command === 'update' || command === 'u') {
    const status = await getVersionStatus();
    if (!status.updateAvailable) {
      console.log(status.latestVersion ? `Already up to date (${status.version}).` : `Installed version: ${status.version}. Could not verify npm registry.`);
      return;
    }
    await updatePackage(status);
    return;
  }

  const versionStatus = await maybeOfferUpdate();
  if (versionStatus.updated) return;

  if (command === '-v' || command === '--version') {
    console.log(versionStatus.version);
    return;
  }

  if (command === '-h' || command === '--help' || command === 'help') {
    printHelp();
    return;
  }

  switch (command) {
    case 'remote':
    case 'r':
      await runRemote(args);
      break;
    case 'doctor':
    case 'd':
      await runDoctor(args, versionStatus);
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
