import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { buildifyxHome } from '../utils/home.js';

export function isInsideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function isGitInternalPath(root, target) {
  const relative = path.relative(root, target);
  return relative.split(path.sep).includes('.git');
}

export function isBuildifyxInternalPath(target, baseDirectory = buildifyxHome()) {
  return isInsideRoot(path.resolve(baseDirectory), path.resolve(target));
}

function assertNotProtectedPath(root, target) {
  if (isGitInternalPath(root, target)) {
    throw new Error('Access to .git internals is not allowed.');
  }
  if (isBuildifyxInternalPath(target)) {
    throw new Error('Access to Buildifyx internal state is not allowed through MCP tools.');
  }
}

export async function resolveSafePath(root, userPath = '.') {
  const requested = path.resolve(root, userPath);

  if (!isInsideRoot(root, requested)) {
    throw new Error('Path is outside the allowed root directory.');
  }

  assertNotProtectedPath(root, requested);

  // Resolve symlinks as well, so a symlink inside root cannot escape root or
  // point into Buildifyx internal state.
  const canonical = await realpath(requested);
  if (!isInsideRoot(root, canonical)) {
    throw new Error('Resolved path is outside the allowed root directory.');
  }

  assertNotProtectedPath(root, canonical);
  return canonical;
}

export async function resolveSafeNewFilePath(root, userPath) {
  const requested = path.resolve(root, userPath);

  if (!isInsideRoot(root, requested)) {
    throw new Error('Path is outside the allowed root directory.');
  }

  assertNotProtectedPath(root, requested);

  const requestedParent = path.dirname(requested);
  const canonicalParent = await realpath(requestedParent);

  if (!isInsideRoot(root, canonicalParent)) {
    throw new Error('Resolved parent path is outside the allowed root directory.');
  }

  assertNotProtectedPath(root, canonicalParent);
  return path.join(canonicalParent, path.basename(requested));
}
