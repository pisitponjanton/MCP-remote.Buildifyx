import { execFile } from 'node:child_process';
import process from 'node:process';
import { checkForUpdate, getPackageMetadata } from '../../version.js';

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { ...options, windowsHide: false }, (error) => {
      if (error) return reject(error);
      resolve();
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
  });
}

export async function runUpdate() {
  const metadata = await getPackageMetadata();
  const status = await checkForUpdate(metadata.name, metadata.version);
  if (!status.updateAvailable) {
    console.log(status.latestVersion ? `Already up to date (${metadata.version}).` : `Installed version: ${metadata.version}. Could not verify npm registry.`);
    return;
  }

  console.log(`Updating ${metadata.name} to the latest version...`);
  await runProcess(npmExecutable(), ['install', '--global', `${metadata.name}@latest`]);
  console.log('Update complete. Run bdxa again to use the latest version.');
}
