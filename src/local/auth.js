import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function localAuthPath(environment) {
  return path.join(environment.rootDirectory, 'auth.json');
}

function generateToken() {
  return randomBytes(32).toString('base64url');
}

async function writeAuth(environment, token) {
  const filePath = localAuthPath(environment);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, token }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
  await chmod(filePath, 0o600).catch(() => undefined);
  return token;
}

export async function readLocalMcpToken(environment) {
  try {
    const parsed = JSON.parse(await readFile(localAuthPath(environment), 'utf8'));
    return typeof parsed?.token === 'string' && parsed.token ? parsed.token : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function getOrCreateLocalMcpToken(environment) {
  const existing = await readLocalMcpToken(environment);
  if (existing) return existing;
  return writeAuth(environment, generateToken());
}

export async function rotateLocalMcpToken(environment) {
  return writeAuth(environment, generateToken());
}

export function localBearerToken(req) {
  const header = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function tokenMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
