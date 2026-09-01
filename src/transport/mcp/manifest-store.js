import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function defaultToolManifestPath(scope = 'default') {
  const suffix = scope === 'default' ? '' : `-${scope}`;
  return path.join(os.homedir(), '.buildifyx', `tool-manifest${suffix}.json`);
}

export async function loadPreviousToolManifest(filePath = defaultToolManifestPath()) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export async function saveToolManifest(manifest, filePath = defaultToolManifestPath()) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return filePath;
}

export async function inspectToolManifest(manifest, filePath = defaultToolManifestPath()) {
  const previous = await loadPreviousToolManifest(filePath);
  const changed = Boolean(previous?.hash && previous.hash !== manifest.hash);
  await saveToolManifest(manifest, filePath);
  return {
    previousHash: previous?.hash ?? null,
    changed,
    filePath
  };
}
