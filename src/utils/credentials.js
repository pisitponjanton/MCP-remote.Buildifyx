import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CREDENTIALS_FILE = path.join(os.homedir(), '.buildifyx', 'credentials.json');

export async function loadCredentials(filePath = DEFAULT_CREDENTIALS_FILE) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function saveCredentials(credentials, filePath = DEFAULT_CREDENTIALS_FILE) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(temp, 0o600).catch(() => {});
  await import('node:fs/promises').then(({ rename }) => rename(temp, filePath));
  await chmod(filePath, 0o600).catch(() => {});
  return filePath;
}

export async function clearCredentials(filePath = DEFAULT_CREDENTIALS_FILE) {
  await rm(filePath, { force: true });
}

export function isCredentialExpired(credentials, now = Date.now()) {
  if (!credentials?.expiresAt) return false;
  const expiry = Date.parse(credentials.expiresAt);
  return Number.isFinite(expiry) && expiry <= now;
}
