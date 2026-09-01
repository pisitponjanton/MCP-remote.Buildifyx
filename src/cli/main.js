import { printHelp } from './help.js';
import { parseInvocation } from './options.js';
import { runCloud } from './commands/cloud.js';
import { runDoctor } from './commands/doctor.js';
import { runInstanceAttach, runInstanceInspect, runInstanceList, runInstanceRemove } from './commands/instances.js';
import { runLogin } from './commands/login.js';
import { runLogout } from './commands/logout.js';
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
    case 'ls':
    case 'ps':
      await runInstanceList(args);
      return;
    case 'inspect':
      await runInstanceInspect(args);
      return;
    case 'attach':
      await runInstanceAttach(args);
      return;
    case 'rm':
      await runInstanceRemove(args);
      return;
    case 'local':
    case 'remote':
    case 'r':
      throw new Error('Local MCP mode has been removed in bdxa 0.2.0. Run `bdxa` to connect through Buildifyx Cloud.');
    case 'doctor':
    case 'd':
      await runDoctor(args);
      return;
    default:
      printHelp();
      throw new Error(`Unknown command: ${command}`);
  }
}
