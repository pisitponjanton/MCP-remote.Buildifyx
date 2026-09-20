import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

export const WORKSPACE_PLAN_KEY_VERSION = 1;

function normalizeCanonicalPathForKey(canonicalPath, platform = process.platform) {
  const normalized = path.normalize(canonicalPath);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export async function canonicalWorkspacePath(workspacePath) {
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
    throw new TypeError('workspacePath is required.');
  }
  return realpath(path.resolve(workspacePath));
}

export function workspacePlanKeyFromCanonicalPath(canonicalPath, platform = process.platform) {
  if (typeof canonicalPath !== 'string' || !canonicalPath.trim()) {
    throw new TypeError('canonicalPath is required.');
  }
  const identity = normalizeCanonicalPathForKey(canonicalPath, platform);
  const digest = createHash('sha256').update(identity).digest('hex');
  return `wp${WORKSPACE_PLAN_KEY_VERSION}_${digest}`;
}

export async function resolveWorkspacePlanIdentity(workspacePath) {
  const canonicalPath = await canonicalWorkspacePath(workspacePath);
  return {
    canonicalPath,
    key: workspacePlanKeyFromCanonicalPath(canonicalPath)
  };
}
