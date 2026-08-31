import { printHelp } from './help.js';
import { parseInvocation } from './options.js';
import { runDoctor } from './commands/doctor.js';
import { runRemote } from './commands/remote.js';
import { runUpdate } from './commands/update.js';
import { getPackageMetadata } from '../version.js';

export async function runCli(argv = process.argv.slice(2)) {
  const { command, args } = parseInvocation(argv);

  if (command === '-h' || command === '--help' || command === 'help') {
    printHelp();
    return;
  }
  if (command === '-v' || command === '--version') {
    console.log((await getPackageMetadata()).version);
    return;
  }
  if (command === 'update' || command === 'u') {
    await runUpdate();
    return;
  }

  switch (command) {
    case 'remote':
    case 'r':
      await runRemote(args);
      return;
    case 'doctor':
    case 'd':
      await runDoctor(args);
      return;
    default:
      printHelp();
      throw new Error(`Unknown command: ${command}`);
  }
}
