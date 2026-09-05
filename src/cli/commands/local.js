import process from 'node:process';
import { createLocalGateway } from '../../local/gateway-server.js';
import {
  DEFAULT_LOCAL_PORT,
  getLocalGatewayStatus,
  parseLocalPort,
  readLocalGatewayConfig,
  readLocalGatewayStartup,
  removeLocalGatewayStartup,
  removeLocalGatewayState,
  startLocalGateway,
  stopLocalGateway
} from '../../local/gateway-control.js';
import { localEnvironment } from '../../runtime/environment.js';
import { listInstances } from '../../utils/instances.js';
import { getOption } from '../options.js';
import {
  runInstanceAttach,
  runInstanceAutostart,
  runInstanceInspect,
  runInstanceList,
  runInstanceRemove,
  runInstanceRestart,
  runInstanceStart,
  runInstanceStop
} from './instances.js';
import { runLocalInstance } from './local-instance.js';

function printLocalHelp() {
  console.log(`bdxa local — Local MCP mode\n\nUsage:\n  bdxa local up [port]             Start the local MCP gateway (default: 3333)\n  bdxa local status                Show local gateway and workspace status\n  bdxa local down                  Stop all local workspaces and the gateway\n\nWorkspaces:\n  bdxa local                       Run this workspace in the foreground\n  bdxa local -d                    Run this workspace in the background\n  bdxa local --name <name>         Give the local workspace a stable name\n  bdxa local --root <path>         Use a workspace without changing directory\n\nManage local instances:\n  bdxa local ls                    List local instances\n  bdxa local inspect <name|id>     Show local instance details\n  bdxa local attach <name|id>      Open the shared terminal dashboard\n  bdxa local start <name|id...>    Start stopped local instances\n  bdxa local restart <name|id...>  Restart local background instances\n  bdxa local restart --all         Restart all running local background instances\n  bdxa local stop <name|id...>     Stop local background instances\n  bdxa local stop --all            Stop all local background instances\n  bdxa local autostart <name|id>   Enable local instance autostart\n  bdxa local autostart off <name|id>\n  bdxa local rm <name|id...>       Remove local instances and their local settings\n  bdxa local rm --all              Remove every local instance\n\nLocal MCP uses No Auth and listens only on 127.0.0.1. Expose the port through your own HTTPS tunnel or reverse proxy when a remote MCP client needs access. Local state is isolated under ~/.buildifyx/local. Cloud login, instances, permissions, and autostart are not used by local mode.\n`);
}

async function requireGateway(environment) {
  const status = await getLocalGatewayStatus(environment);
  if (!status.running) throw new Error('Local gateway is not running. Start it first with `bdxa local up`.');
  return status;
}

export async function runLocal(args = [], { metadata = null, updateStatus = null } = {}) {
  const environment = localEnvironment();
  const first = args[0];

  if (first === 'help' || first === '-h' || first === '--help') {
    printLocalHelp();
    return;
  }

  if (first === 'up') {
    if (args.length > 2) throw new Error('Usage: bdxa local up [port]');
    const port = parseLocalPort(args[1] ?? DEFAULT_LOCAL_PORT);
    const result = await startLocalGateway({
      environment,
      cliEntry: process.argv[1],
      port,
      version: metadata?.version ?? 'unknown'
    });
    console.log(result.alreadyRunning ? 'Local gateway is already running.' : '✓ Local gateway started');
    console.log(`  MCP        http://127.0.0.1:${result.state.port}/mcp`);
    console.log(`  Port       ${result.state.port}`);
    console.log(`  PID        ${result.state.pid}`);
    console.log('  Auth       No Auth');
    console.log('  Remote     Expose this port through your own HTTPS tunnel/reverse proxy');
    return;
  }

  if (first === 'status') {
    const gateway = await getLocalGatewayStatus(environment);
    const instances = await listInstances(environment.instancesDirectory, { transport: environment.kind });
    const running = instances.filter((item) => item.live).length;
    console.log('Buildifyx Local');
    console.log('');
    console.log(`Status      ${gateway.running ? 'running' : 'stopped'}`);
    if (gateway.running) {
      console.log(`MCP         http://127.0.0.1:${gateway.state.port}/mcp`);
      console.log(`Port        ${gateway.state.port}`);
      console.log(`PID         ${gateway.state.pid}`);
      console.log('Auth        No Auth');
    }
    console.log(`Instances   ${running} running / ${Math.max(0, instances.length - running)} stopped`);
    if (!gateway.running) console.log('\nStart with:\n  bdxa local up');
    return;
  }

  if (first === 'down') {
    if (args.length > 1) throw new Error('Usage: bdxa local down');
    const instances = await listInstances(environment.instancesDirectory, { transport: environment.kind });
    if (instances.some((item) => item.live && !item.processOnly)) {
      await runInstanceStop(['--all'], { environment, includeForeground: true, preserveForegroundRecord: false });
    }
    const result = await stopLocalGateway(environment);
    console.log(result.alreadyStopped ? 'Local gateway is already stopped.' : '✓ Local gateway stopped');
    return;
  }

  const managementCommands = new Set(['ls', 'ps', 'inspect', 'attach', 'start', 'restart', 'stop', 'autostart', 'rm']);
  if (first && !first.startsWith('-') && !managementCommands.has(first)) {
    throw new Error(`Unknown local command: ${first}. Run \`bdxa local help\`.`);
  }

  await requireGateway(environment);

  if (!first || first.startsWith('-')) {
    await runLocalInstance(args, { metadata, updateStatus });
    return;
  }

  const common = { environment };
  switch (first) {
    case 'ls':
    case 'ps':
      await runInstanceList(args.slice(1), common);
      return;
    case 'inspect':
      await runInstanceInspect(args.slice(1), common);
      return;
    case 'attach':
      await runInstanceAttach(args.slice(1), { environment, metadata, updateStatus });
      return;
    case 'start':
      await runInstanceStart(args.slice(1), common);
      return;
    case 'restart':
      await runInstanceRestart(args.slice(1), common);
      return;
    case 'stop':
      await runInstanceStop(args.slice(1), common);
      return;
    case 'autostart':
      await runInstanceAutostart(args.slice(1), common);
      return;
    case 'rm':
      await runInstanceRemove(args.slice(1), common);
      return;
    default:
      throw new Error(`Unknown local command: ${first}. Run \`bdxa local help\`.`);
  }
}

export async function runLocalGatewayChild(args = [], { metadata = null } = {}) {
  const environment = localEnvironment();
  const port = parseLocalPort(getOption(args, '--port', String(DEFAULT_LOCAL_PORT)));
  const gatewayId = getOption(args, '--gateway-id', null);
  if (!gatewayId) throw new Error('Local gateway child is missing its startup identity.');
  const startup = await readLocalGatewayStartup(environment);
  if (!startup || startup.gatewayId !== gatewayId || typeof startup.controlToken !== 'string' || !startup.controlToken) {
    throw new Error('Local gateway child could not load its private startup secret.');
  }
  const controlToken = startup.controlToken;
  await removeLocalGatewayStartup(environment).catch(() => undefined);

  const gateway = createLocalGateway({
    environment,
    version: metadata?.version ?? 'unknown',
    gatewayId,
    controlToken
  });
  const server = await gateway.start(port);
  let closing = false;
  const closeAndExit = async (code = 0) => {
    if (closing) return;
    closing = true;
    await server.close().catch(() => undefined);
    await removeLocalGatewayState(environment).catch(() => undefined);
    process.exit(code);
  };
  process.once('SIGINT', () => { void closeAndExit(0); });
  process.once('SIGTERM', () => { void closeAndExit(0); });
}


export async function ensureLocalGatewayForAutostart({ metadata = null } = {}) {
  const environment = localEnvironment();
  const config = await readLocalGatewayConfig(environment);
  return startLocalGateway({
    environment,
    cliEntry: process.argv[1],
    port: config.port,
    version: metadata?.version ?? 'unknown'
  });
}
