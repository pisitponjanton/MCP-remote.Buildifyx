import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { registerSystemTools } from './tools/system.js';
import { registerFileTools } from './tools/files.js';
import { registerCommandTools } from './tools/commands.js';

function isAllowedOrigin(origin) {
  if (!origin) return true; // server-to-server calls normally have no Origin
  try {
    const url = new URL(origin);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  } catch {
    return false;
  }
}

function buildMcpServer({ root }) {
  const server = new McpServer({
    name: 'buildifyx-desktop-agent',
    version: '0.1.0'
  });

  registerSystemTools(server, { root });
  registerFileTools(server, { root });
  registerCommandTools(server, { root });
  return server;
}

export async function startMcpServer({ root, port }) {
  const handler = createMcpHandler(() => buildMcpServer({ root }), {
    responseMode: 'json'
  });
  const nodeHandler = toNodeHandler(handler);

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (!isAllowedOrigin(req.headers.origin)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Origin not allowed' }));
      return;
    }

    void nodeHandler(req, res);
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', resolve);
  });

  console.log('Buildifyx Desktop Agent');
  console.log(`Root:   ${root}`);
  console.log(`MCP:    http://127.0.0.1:${port}/mcp`);
  console.log(`Health: http://127.0.0.1:${port}/health`);
  console.log('Mode:   private / root-scoped read-write-command');
  console.log('\nKeep this process running while the Secure MCP Tunnel is connected.');

  const shutdown = async () => {
    console.log('\nShutting down...');
    await handler.close();
    await new Promise((resolve) => httpServer.close(resolve));
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
