import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizePolicy } from './policy.js';

export function defaultPolicyPath() {
  return path.join(os.homedir(), '.buildifyx', 'policy.json');
}

export async function loadPolicy(filePath = defaultPolicyPath()) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return normalizePolicy(JSON.parse(raw));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return normalizePolicy();
    }
    throw error;
  }
}

export async function savePolicy(policy, filePath = defaultPolicyPath()) {
  const normalized = normalizePolicy(policy);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}
