import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isBuildifyxInternalPath, isInsideRoot } from './path.js';
import { AgentError, ErrorCode, asFileError } from '../core/errors.js';

function matchingRoot(roots, target) {
  return roots.find((root) => isInsideRoot(root, target)) ?? null;
}

function assertNotProtectedPath(target) {
  if (path.resolve(target).split(path.sep).includes('.git')) {
    throw new AgentError(ErrorCode.GIT_INTERNAL_PATH, 'Access to .git internals is not allowed.');
  }
  if (isBuildifyxInternalPath(target)) {
    throw new AgentError(ErrorCode.PERMISSION_DENIED, 'Access to Buildifyx internal state is not allowed through MCP tools.');
  }
}

export async function normalizeRoots(primaryRoot, additionalRoots = []) {
  const roots = [await realpath(primaryRoot)];
  for (const candidate of additionalRoots) {
    try {
      const canonical = await realpath(candidate);
      if (!roots.includes(canonical)) roots.push(canonical);
    } catch {
      // Invalid persisted roots are ignored until the user fixes them in the TUI.
    }
  }
  return roots;
}

export async function classifyPath({ root, additionalRoots = [], userPath = '.', newFile = false }) {
  const roots = await normalizeRoots(root, additionalRoots);
  const requested = path.isAbsolute(userPath) ? path.resolve(userPath) : path.resolve(root, userPath);
  assertNotProtectedPath(requested);

  if (newFile) {
    const parent = await realpath(path.dirname(requested)).catch(error => { throw asFileError(error, { missing: ErrorCode.FILE_PARENT_NOT_FOUND, notDirectory: ErrorCode.FILE_PARENT_NOT_FOUND }); });
    const resolved = path.join(parent, path.basename(requested));
    assertNotProtectedPath(resolved);
    const matchedRoot = matchingRoot(roots, resolved);
    return { requested, resolved, matchedRoot, scope: matchedRoot ? (matchedRoot === roots[0] ? 'root' : 'additional') : 'outside' };
  }

  const resolved = await realpath(requested).catch(error => { throw asFileError(error, { notDirectory: ErrorCode.FILE_NOT_FOUND }); });
  assertNotProtectedPath(resolved);
  const matchedRoot = matchingRoot(roots, resolved);
  return { requested, resolved, matchedRoot, scope: matchedRoot ? (matchedRoot === roots[0] ? 'root' : 'additional') : 'outside' };
}
