import { readFile } from 'node:fs/promises';

const packageJsonUrl = new URL('../package.json', import.meta.url);

export async function getPackageMetadata() {
  const content = await readFile(packageJsonUrl, 'utf8');
  const metadata = JSON.parse(content);

  return {
    name: metadata.name,
    version: metadata.version
  };
}

function parseVersion(version) {
  const normalized = version.trim().replace(/^v/, '');
  const [core, prerelease = ''] = normalized.split('-', 2);
  const parts = core.split('.').map((part) => Number(part));

  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    return null;
  }

  return {
    core: parts,
    prerelease: prerelease ? prerelease.split('.') : []
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];

    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;

    const aNumber = /^\d+$/.test(a) ? Number(a) : null;
    const bNumber = /^\d+$/.test(b) ? Number(b) : null;

    if (aNumber !== null && bNumber !== null) return aNumber > bNumber ? 1 : -1;
    if (aNumber !== null) return -1;
    if (bNumber !== null) return 1;
    return a > b ? 1 : -1;
  }

  return 0;
}

export function compareVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);

  if (!left || !right) {
    return leftVersion === rightVersion ? 0 : null;
  }

  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] > right.core[index]) return 1;
    if (left.core[index] < right.core[index]) return -1;
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}

export async function getLatestNpmVersion(packageName, { timeoutMs = 2000 } = {}) {
  const encodedName = packageName.replace('/', '%2f');
  const response = await fetch(`https://registry.npmjs.org/${encodedName}/latest`, {
    headers: {
      accept: 'application/json'
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${response.status}`);
  }

  const metadata = await response.json();
  if (!metadata || typeof metadata.version !== 'string' || !metadata.version) {
    throw new Error('npm registry response does not contain a version.');
  }

  return metadata.version;
}

export async function checkForUpdate(packageName, currentVersion, options) {
  try {
    const latestVersion = await getLatestNpmVersion(packageName, options);
    const comparison = compareVersions(latestVersion, currentVersion);

    return {
      currentVersion,
      latestVersion,
      updateAvailable: comparison === 1
    };
  } catch (error) {
    return {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function formatUpdateNotice(status) {
  if (!status?.updateAvailable || !status.latestVersion) return null;
  return `Update available: v${status.currentVersion} → v${status.latestVersion}. Run \`bdxa update\`.`;
}

export function resolveAttachedUpdateStatus({ runningVersion, installedVersion, updateStatus = null } = {}) {
  const restartRequired = Boolean(
    runningVersion
    && installedVersion
    && compareVersions(installedVersion, runningVersion) === 1
  );

  return {
    ...(updateStatus ?? {}),
    runningVersion: runningVersion ?? installedVersion ?? null,
    installedVersion: installedVersion ?? runningVersion ?? null,
    restartRequired
  };
}
