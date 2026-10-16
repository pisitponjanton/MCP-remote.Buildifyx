import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { buildifyxHome } from '../utils/home.js';
import { AgentError, ErrorCode, asFileError } from '../core/errors.js';

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
    throw new AgentError(ErrorCode.GIT_INTERNAL_PATH, 'Access to .git internals is not allowed.');
  }
  if (isBuildifyxInternalPath(target)) {
    throw new AgentError(ErrorCode.PERMISSION_DENIED, 'Access to Buildifyx internal state is not allowed through MCP tools.');
  }
}

export async function resolveSafePath(root, userPath = '.') {
  const requested = path.resolve(root, userPath);

  if (!isInsideRoot(root, requested)) {
    throw new AgentError(ErrorCode.PATH_OUTSIDE_ROOT, 'Path is outside the allowed root directory.');
  }

  assertNotProtectedPath(root, requested);

  // Resolve symlinks as well, so a symlink inside root cannot escape root or
  // point into Buildifyx internal state.
  const canonical = await realpath(requested).catch(error => { throw asFileError(error, { notDirectory: ErrorCode.FILE_NOT_FOUND }); });
  if (!isInsideRoot(root, canonical)) {
    throw new AgentError(ErrorCode.PATH_OUTSIDE_ROOT, 'Resolved path is outside the allowed root directory.');
  }

  assertNotProtectedPath(root, canonical);
  return canonical;
}

export async function resolveSafeNewFilePath(root, userPath) {
  const requested = path.resolve(root, userPath);

  if (!isInsideRoot(root, requested)) {
    throw new AgentError(ErrorCode.PATH_OUTSIDE_ROOT, 'Path is outside the allowed root directory.');
  }

  assertNotProtectedPath(root, requested);

  const requestedParent = path.dirname(requested);
  const canonicalParent = await realpath(requestedParent).catch(error => { throw asFileError(error, { missing: ErrorCode.FILE_PARENT_NOT_FOUND, notDirectory: ErrorCode.FILE_PARENT_NOT_FOUND }); });

  if (!isInsideRoot(root, canonicalParent)) {
    throw new AgentError(ErrorCode.PATH_OUTSIDE_ROOT, 'Resolved parent path is outside the allowed root directory.');
  }

  assertNotProtectedPath(root, canonicalParent);
  return path.join(canonicalParent, path.basename(requested));
}
