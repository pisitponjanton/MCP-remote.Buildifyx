import os from 'node:os';
import process from 'node:process';
import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { loginDevice, DEFAULT_CLOUD_ORIGIN } from '../../transport/cloud.js';
import { saveCredentials } from '../../utils/credentials.js';
import { getPackageMetadata } from '../../version.js';
import { getOption } from '../options.js';

async function promptToken() {
  if (!process.stdin.isTTY) throw new Error('Login token is required. Use --token or run `bdxa login` in a terminal.');

  return new Promise((resolve, reject) => {
    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw === true;
    const wasPaused = input.isPaused();
    let token = '';

    const cleanup = () => {
      input.off('keypress', onKeypress);
      if (typeof input.setRawMode === 'function') input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
    };

    const onKeypress = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        output.write('\n');
        reject(new Error('Login cancelled.'));
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        output.write('\n');
        resolve(token.trim());
        return;
      }

      if (key.name === 'backspace' || key.name === 'delete') {
        if (token.length) {
          token = token.slice(0, -1);
          output.write('\b \b');
        }
        return;
      }

      if (text && !key.ctrl && !key.meta && !key.sequence?.startsWith('\u001b')) {
        token += text;
        output.write('•');
      }
    };

    output.write('Login token: ');
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.resume();
    input.on('keypress', onKeypress);
  });
}

export async function runLogin(args, { showConnectHint = true } = {}) {
  const cloudUrl = getOption(args, '--cloud', DEFAULT_CLOUD_ORIGIN);
  const token = getOption(args, '--token', null) ?? await promptToken();
  if (!token) throw new Error('Login token cannot be empty.');

  const metadata = await getPackageMetadata();
  console.log(`\nConnecting to ${cloudUrl}...`);
  const response = await loginDevice({
    cloudUrl,
    token,
    device: {
      name: os.hostname(),
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      agentVersion: metadata.version
    }
  });

  const deviceToken = response?.credential?.token ?? response?.deviceToken;
  const deviceId = response?.device?.id ?? response?.deviceId;
  const expiresAt = response?.credential?.expiresAt ?? response?.expiresAt ?? null;
  if (!deviceToken || !deviceId) throw new Error('Cloud login response did not include a device credential.');

  await saveCredentials({
    cloudUrl,
    deviceId,
    deviceName: response?.device?.name ?? os.hostname(),
    account: response?.user?.email ?? response?.account ?? null,
    deviceToken,
    expiresAt,
    createdAt: new Date().toISOString()
  });

  console.log('✓ Signed in successfully');
  console.log(`  Device   ${response?.device?.name ?? os.hostname()}`);
  if (response?.user?.email) console.log(`  Account  ${response.user.email}`);
  if (expiresAt) console.log(`  Expires  ${expiresAt}`);
  if (showConnectHint) console.log('\nRun `bdxa` inside the workspace you want ChatGPT to use.');
}
