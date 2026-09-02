import { printHelp } from './help.js';
import { parseInvocation } from './options.js';
import { runCloud } from './commands/cloud.js';
import { runDoctor } from './commands/doctor.js';
import { runInstanceAttach, runInstanceInspect, runInstanceList, runInstanceRemove, runInstanceRestart } from './commands/instances.js';
import { runLogin } from './commands/login.js';
import { runLogout } from './commands/logout.js';
import { runStatus } from './commands/status.js';
import { runUpdate } from './commands/update.js';
import { checkForUpdate, formatUpdateNotice, getPackageMetadata } from '../version.js';

function printUpdateNotice(status) {
  const notice = formatUpdateNotice(status);
  if (!notice) return;
  console.error(`\n⚠ ${notice}\n`);
}

async function getInvocationUpdateStatus(command, args, metadata) {
  if (process.env.BUILDFYX_SKIP_UPDATE_CHECK === '1') return null;
  if (command === 'update' || command === 'u' || command === 'doctor' || command === 'd') return null;
  if (args.includes('--background-child') || args.includes('--handoff-child')) return null;
  return checkForUpdate(metadata.name, metadata.version, { timeoutMs: 1200 });
}

export async function runUpdateCommand(args = [], { update = runUpdate, restart = runInstanceRestart } = {}) {
  await update();
  if (args.includes('--restart')) await restart(['--all']);
}

export async function runCli(argv = process.argv.slice(2)) {
  const { command, args } = parseInvocation(argv);
  const metadata = await getPackageMetadata();
  const updateStatus = await getInvocationUpdateStatus(command, args, metadata);

  if (command === '-h' || command === '--help' || command === 'help') {
    printUpdateNotice(updateStatus);
    printHelp();
    return;
  }
  if (command === '-v' || command === '--version') {
    console.log(metadata.version);
    printUpdateNotice(updateStatus);
    return;
  }
  if (command === 'update' || command === 'u') {
    await runUpdateCommand(args);
    return;
  }

  switch (command) {
    case 'cloud':
    case 'connect':
      printUpdateNotice(updateStatus);
      await runCloud(args, { metadata, updateStatus });
      return;
    case 'login':
      printUpdateNotice(updateStatus);
      await runLogin(args);
      return;
    case 'logout':
      printUpdateNotice(updateStatus);
      await runLogout();
      return;
    case 'status':
      printUpdateNotice(updateStatus);
      await runStatus();
      return;
    case 'ls':
    case 'ps':
      printUpdateNotice(updateStatus);
      await runInstanceList(args);
      return;
    case 'inspect':
      printUpdateNotice(updateStatus);
      await runInstanceInspect(args);
      return;
    case 'attach':
      printUpdateNotice(updateStatus);
      await runInstanceAttach(args, { metadata, updateStatus });
      return;
    case 'restart':
      printUpdateNotice(updateStatus);
      await runInstanceRestart(args);
      return;
    case 'rm':
      printUpdateNotice(updateStatus);
      await runInstanceRemove(args);
      return;
    case 'local':
    case 'remote':
    case 'r':
      printUpdateNotice(updateStatus);
      throw new Error('Local MCP mode has been removed in bdxa 0.2.0. Run `bdxa` to connect through Buildifyx Cloud.');
    case 'doctor':
    case 'd':
      printUpdateNotice(updateStatus);
      await runDoctor(args);
      return;
    default:
      printUpdateNotice(updateStatus);
      printHelp();
      throw new Error(`Unknown command: ${command}`);
  }
}
