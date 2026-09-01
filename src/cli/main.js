import { printHelp } from './help.js';
import { parseInvocation } from './options.js';
import { runCloud } from './commands/cloud.js';
import { runDoctor } from './commands/doctor.js';
import { runLogin } from './commands/login.js';
import { runLogout } from './commands/logout.js';
import { runRemote } from './commands/remote.js';
import { runStatus } from './commands/status.js';
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
    case 'cloud':
    case 'connect':
      await runCloud(args);
      return;
    case 'login':
      await runLogin(args);
      return;
    case 'logout':
      await runLogout();
      return;
    case 'status':
      await runStatus();
      return;
    case 'local':
      await runRemote(args);
      return;
    case 'remote':
    case 'r':
      throw new Error('`bdxa remote` has been removed. Use `bdxa` for Buildifyx Cloud or `bdxa local` for local development.');
    case 'doctor':
    case 'd':
      await runDoctor(args);
      return;
    default:
      printHelp();
      throw new Error(`Unknown command: ${command}`);
  }
}
