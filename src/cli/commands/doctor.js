import process from 'node:process';
import { getOption, resolveRoot } from '../options.js';
import { checkForUpdate, getPackageMetadata } from '../../version.js';

export async function runDoctor(args) {
  const root = await resolveRoot(getOption(args, '--root', process.cwd()));
  const metadata = await getPackageMetadata();
  const versionStatus = await checkForUpdate(metadata.name, metadata.version);

  console.log('Buildifyx Desktop Agent doctor');
  console.log(`Node:     ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Root:     ${root}`);
  console.log(`Version:  ${metadata.version}${versionStatus.updateAvailable && versionStatus.latestVersion ? ` (latest: ${versionStatus.latestVersion})` : ''}`);
  if (versionStatus.error) console.log(`Registry: unavailable (${versionStatus.error})`);
  else if (!versionStatus.updateAvailable) console.log('Registry: latest');
  console.log('Status:   OK');
}
