// Release test fixtures must never target the repository, home directory,
// or a production installation. GitHub Actions RUNNER_TEMP may differ from
// os.tmpdir(), especially on Windows hosted runners.
import { lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function requireIsolatedReleasePrefix(value, { env = process.env, tempDirectory = os.tmpdir() } = {}) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    throw new Error('Provide an absolute, isolated package prefix under a temporary directory.');
  }
  const target = path.resolve(value);
  // A checkout can itself be located beneath /tmp (for example inside a
  // Linux release container). It must never qualify as an install prefix.
  const checkout = path.resolve(process.cwd());
  const withinCheckout = path.relative(checkout, target);
  if (!withinCheckout || (withinCheckout !== '..'
    && !withinCheckout.startsWith('..' + path.sep)
    && !path.isAbsolute(withinCheckout))) {
    throw new Error('Release package prefix must not point inside the source checkout.');
  }
  const roots = [tempDirectory];
  if (process.platform !== 'win32') roots.push('/tmp', '/private/tmp');
  if ((env.CI === 'true' || env.CI === '1') && typeof env.RUNNER_TEMP === 'string'
    && path.isAbsolute(env.RUNNER_TEMP)) {
    roots.push(env.RUNNER_TEMP);
  }
  const contained = roots.some(candidate => {
    const root = path.resolve(candidate);
    const relative = path.relative(root, target);
    return relative && relative !== '.' && relative !== '..'
      && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  });
  if (!contained) throw new Error('Release package prefix must be within an isolated temporary directory.');
  // A lexical /tmp/child path can still resolve through a link to a user
  // directory. Reject any pre-existing symbolic link/junction below each
  // trusted temp root, even if the link currently points back inside /tmp.
  // Root aliases such as macOS /tmp -> /private/tmp remain supported.
  for (const candidate of roots) {
    const root = path.resolve(candidate);
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep)
      || path.isAbsolute(relative)) continue;
    let cursor = root;
    const components = relative.split(path.sep);
    for (const [index, component] of components.entries()) {
      cursor = path.join(cursor, component);
      let metadata;
      try { metadata = lstatSync(cursor); }
      catch (error) {
        if (error?.code === 'ENOENT') break; // non-existent isolated child is allowed
        throw error;
      }
      if (metadata.isSymbolicLink()) {
        throw new Error('Release package prefix must not traverse a symlink or junction.');
      }
      if (!metadata.isDirectory()) {
        throw new Error('Release package prefix must be a directory within an isolated temporary root.');
      }
    }
  }
  return target;
}
