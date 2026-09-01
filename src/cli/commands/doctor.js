import process from 'node:process';
import { getOption, resolveRoot } from '../options.js';
import { checkForUpdate, getPackageMetadata } from '../../version.js';

export async function runDoctor(args) {
  const root = await resolveRoot(getOption(args, '--root', process.cwd()));
  const metadata = await getPackageMetadata();
  const versionStatus = await checkForUpdate(metadata.name, metadata.version);

  console.log('Buildifyx Desktop Agent doctor');
  console.log('');
  console.log('Environment');
  console.log(`  Node       ${process.version}`);
  console.log(`  Platform   ${process.platform} ${process.arch}`);
  console.log(`  Workspace  ${root}`);
  console.log(`  Version    ${metadata.version}`);
  console.log('');

  if (versionStatus.error) {
    console.log('! npm registry could not be checked');
    console.log(`  ${versionStatus.error}`);
    console.log('');
    console.log('Status: OK with warnings');
    return;
  }

  if (versionStatus.updateAvailable && versionStatus.latestVersion) {
    console.log(`! Update available: ${versionStatus.latestVersion}`);
    console.log('  Run `bdxa update` to install it.');
    console.log('');
    console.log('Status: UPDATE AVAILABLE');
    return;
  }

  console.log('✓ npm package is up to date');
  console.log('');
  console.log('Status: OK');
}
