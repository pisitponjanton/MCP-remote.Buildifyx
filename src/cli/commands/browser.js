import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);

export function browserInstallationStatus({ adapter = chromium, fileExists = existsSync } = {}) {
  const executablePath = adapter.executablePath();
  const installed = fileExists(executablePath);
  return { installed, executablePath, platform: process.platform, architecture: process.arch };
}

export async function installBrowser({ runInstaller } = {}) {
  // Execute the CLI shipped by our declared Playwright dependency, not a
  // user-controlled PATH command or a moving npx "latest" download.
  const installedPackage = require.resolve('playwright/package.json');
  const cli = path.join(path.dirname(installedPackage), 'cli.js');
  const run = runInstaller ?? ((command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, shell: false });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error('Chromium installation failed (' + (signal ?? code) + ').'));
    });
  }));
  await run(process.execPath, [cli, 'install', 'chromium']);
}

export async function runBrowser(args = [], { status = browserInstallationStatus, install = installBrowser, print = console.log } = {}) {
  const [command = 'check', ...rest] = args;
  if (rest.length || !['check', 'install'].includes(command)) {
    throw new Error('Use `bdxa browser check` or `bdxa browser install`.');
  }
  if (command === 'install') {
    print('Installing Playwright Chromium explicitly for this local device...');
    await install();
  }
  const info = await status();
  print(info.installed
    ? 'Playwright Chromium: installed (' + info.platform + ' ' + info.architecture + ')'
    : 'Playwright Chromium: not installed for this device.');
  if (info.installed && info.platform === 'linux') {
    print('Executable check only: required Linux system libraries are validated when Browser Tools launch.');
  }
  if (!info.installed) {
    print('Run `bdxa browser install` to download Chromium. No browser download occurs during npm install.');
    if (command === 'install') throw new Error('Chromium installation finished without the expected browser executable.');
  }
  return info;
}
