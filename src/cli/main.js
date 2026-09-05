import { printHelp } from './help.js';
import { parseInvocation } from './options.js';
import { runCloud } from './commands/cloud.js';
import { runDoctor } from './commands/doctor.js';
import { runInstanceAttach, runInstanceAutostart, runInstanceInspect, runInstanceList, runInstanceRemove, runInstanceRestart, runInstanceStart, runInstanceStop } from './commands/instances.js';
import { runLogin } from './commands/login.js';
import { ensureLocalGatewayForAutostart, runLocal, runLocalGatewayChild } from './commands/local.js';
import { runLogout } from './commands/logout.js';
import { runStatus } from './commands/status.js';
import { runUpdate } from './commands/update.js';
import { getAutostartInstanceIds, restoreAutostartInstances } from '../services/autostart.js';
import { localEnvironment } from '../runtime/environment.js';
import { getLocalGatewayStatus, readLocalGatewayConfig, startLocalGateway, stopLocalGateway } from '../local/gateway-control.js';
import { listInstances } from '../utils/instances.js';
import { checkForUpdate, formatUpdateNotice, getPackageMetadata } from '../version.js';

function printUpdateNotice(status) {
  const notice = formatUpdateNotice(status);
  if (!notice) return;
  console.error(`\n⚠ ${notice}\n`);
}

async function getInvocationUpdateStatus(command, args, metadata) {
  if (process.env.BUILDFYX_SKIP_UPDATE_CHECK === '1') return null;
  if (command.startsWith('__')) return null;
  if (command === 'update' || command === 'u' || command === 'doctor' || command === 'd') return null;
  if (args.includes('--background-child') || args.includes('--handoff-child')) return null;
  return checkForUpdate(metadata.name, metadata.version, { timeoutMs: 1200 });
}

export async function runUpdateCommand(args = [], options = {}) {
  const update = options.update ?? runUpdate;
  const restartCloud = options.restartCloud ?? options.restart ?? runInstanceRestart;
  const restartLocal = options.restartLocal ?? runInstanceRestart;
  const readLocalStatus = options.getLocalGatewayStatus ?? getLocalGatewayStatus;
  const readLocalConfig = options.readLocalGatewayConfig ?? readLocalGatewayConfig;
  const listLocalInstances = options.listLocalInstances ?? ((environment) => listInstances(environment.instancesDirectory, { transport: environment.kind }));
  const stopGateway = options.stopLocalGateway ?? stopLocalGateway;
  const startGateway = options.startLocalGateway ?? startLocalGateway;
  const readMetadata = options.getPackageMetadata ?? getPackageMetadata;
  const restartRequested = args.includes('--restart');
  const environment = localEnvironment();
  const localGateway = restartRequested ? await readLocalStatus(environment) : null;
  const localRunningIds = restartRequested
    ? (await listLocalInstances(environment))
      .filter((item) => item.live && item.mode === 'background' && !item.processOnly)
      .map((item) => item.instanceId)
    : [];
  const localConfig = restartRequested && !localGateway?.running && localRunningIds.length
    ? await readLocalConfig(environment)
    : null;

  await update();
  if (!restartRequested) return;

  const failures = [];
  try { await restartCloud(['--all']); }
  catch (error) { failures.push(`Cloud: ${error?.message ?? String(error)}`); }

  if (localGateway?.running || localRunningIds.length) {
    let gatewayReady = false;
    try {
      if (localGateway?.running) await stopGateway(environment);
      const metadata = await readMetadata();
      await startGateway({
        environment,
        cliEntry: process.argv[1],
        port: localGateway?.state?.port ?? localConfig?.port,
        version: metadata.version
      });
      gatewayReady = true;
    } catch (error) {
      failures.push(`Local gateway: ${error?.message ?? String(error)}`);
    }

    if (gatewayReady && localRunningIds.length) {
      try { await restartLocal(localRunningIds, { environment }); }
      catch (error) { failures.push(`Local: ${error?.message ?? String(error)}`); }
    }
  }

  if (failures.length) throw new Error(`Update completed, but restart failed: ${failures.join('; ')}`);
}

export async function runCli(argv = process.argv.slice(2)) {
  const { command, args } = parseInvocation(argv);
  const metadata = await getPackageMetadata();
  const updateStatus = await getInvocationUpdateStatus(command, args, metadata);

  if (command === '__autostart-restore') {
    const environment = args[0] === 'local' ? localEnvironment() : undefined;
    if (environment && (await getAutostartInstanceIds({ environment })).size > 0) {
      await ensureLocalGatewayForAutostart({ metadata });
    }
    const result = await restoreAutostartInstances(environment ? { environment } : {});
    if (result.failed.length) {
      console.error(`Autostart restored ${result.restored} instance(s) with ${result.failed.length} failure(s).`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === '__local-gateway') {
    await runLocalGatewayChild(args, { metadata });
    return;
  }

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
    case 'start':
      printUpdateNotice(updateStatus);
      await runInstanceStart(args);
      return;
    case 'restart':
      printUpdateNotice(updateStatus);
      await runInstanceRestart(args);
      return;
    case 'stop':
      printUpdateNotice(updateStatus);
      await runInstanceStop(args);
      return;
    case 'autostart':
      printUpdateNotice(updateStatus);
      await runInstanceAutostart(args);
      return;
    case 'rm':
      printUpdateNotice(updateStatus);
      await runInstanceRemove(args);
      return;
    case 'local':
      printUpdateNotice(updateStatus);
      await runLocal(args, { metadata, updateStatus });
      return;
    case 'remote':
    case 'r':
      printUpdateNotice(updateStatus);
      throw new Error('Legacy remote mode has been removed. Use `bdxa` for Cloud or `bdxa local` for Local MCP.');
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