import process from 'node:process';
import { startMcpServer } from '../../transport/mcp/server.js';
import { getOption, hasFlag, parsePort, resolveRoot } from '../options.js';

export async function runRemote(args) {
  const root = await resolveRoot(getOption(args, '--root', process.cwd()));
  const port = parsePort(getOption(args, '--port', '3333'));
  const fullAccess = hasFlag(args, '--full-access');
  const server = await startMcpServer({ root, port, fullAccess });

  const shutdown = async () => {
    console.log('\nShutting down...');
    await server.close();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
