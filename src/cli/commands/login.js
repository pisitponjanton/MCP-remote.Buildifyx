import os from 'node:os';
import process from 'node:process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loginDevice, DEFAULT_CLOUD_ORIGIN } from '../../transport/cloud.js';
import { saveCredentials } from '../../utils/credentials.js';
import { getPackageMetadata } from '../../version.js';
import { getOption } from '../options.js';

async function promptToken() {
  if (!process.stdin.isTTY) throw new Error('Login token is required. Use --token or run bdxa login in a terminal.');
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question('Login token: ')).trim();
  } finally {
    rl.close();
  }
}

export async function runLogin(args) {
  const cloudUrl = getOption(args, '--cloud', DEFAULT_CLOUD_ORIGIN);
  const token = getOption(args, '--token', null) ?? await promptToken();
  if (!token) throw new Error('Login token cannot be empty.');

  const metadata = await getPackageMetadata();
  console.log(`Connecting to ${cloudUrl}...`);
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

  console.log('✓ Authentication successful');
  console.log(`Device:  ${response?.device?.name ?? os.hostname()}`);
  if (response?.user?.email) console.log(`Account: ${response.user.email}`);
  if (expiresAt) console.log(`Expires: ${expiresAt}`);
  console.log('Run `bdxa` to connect this device to Buildifyx Cloud.');
}
