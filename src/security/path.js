import { realpath } from 'node:fs/promises';
import path from 'node:path';

export function isInsideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function isGitInternalPath(root, target) {
  const relative = path.relative(root, target);
  return relative.split(path.sep).includes('.git');
}

export async function resolveSafePath(root, userPath = '.') {
  const requested = path.resolve(root, userPath);

  if (!isInsideRoot(root, requested)) {
    throw new Error('Path is outside the allowed root directory.');
  }

  if (isGitInternalPath(root, requested)) {
    throw new Error('Access to .git internals is not allowed.');
  }

  // Resolve symlinks as well, so a symlink inside root cannot escape root.
  const canonical = await realpath(requested);
  if (!isInsideRoot(root, canonical)) {
    throw new Error('Resolved path is outside the allowed root directory.');
  }

  if (isGitInternalPath(root, canonical)) {
    throw new Error('Access to .git internals is not allowed.');
  }

  return canonical;
}
