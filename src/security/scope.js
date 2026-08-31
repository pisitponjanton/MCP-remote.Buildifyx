import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isInsideRoot } from './path.js';

function matchingRoot(roots, target) {
  return roots.find((root) => isInsideRoot(root, target)) ?? null;
}

function assertNotGitInternal(target) {
  if (path.resolve(target).split(path.sep).includes('.git')) {
    throw new Error('Access to .git internals is not allowed.');
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
  assertNotGitInternal(requested);

  if (newFile) {
    const parent = await realpath(path.dirname(requested));
    const resolved = path.join(parent, path.basename(requested));
    assertNotGitInternal(resolved);
    const matchedRoot = matchingRoot(roots, resolved);
    return { requested, resolved, matchedRoot, scope: matchedRoot ? (matchedRoot === roots[0] ? 'root' : 'additional') : 'outside' };
  }

  const resolved = await realpath(requested);
  assertNotGitInternal(resolved);
  const matchedRoot = matchingRoot(roots, resolved);
  return { requested, resolved, matchedRoot, scope: matchedRoot ? (matchedRoot === roots[0] ? 'root' : 'additional') : 'outside' };
}
