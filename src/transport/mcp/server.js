import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createRuntime } from '../../core/runtime.js';
import { registerMcpTools } from './tools/index.js';

const require = createRequire(import.meta.url);
const { version: packageVersion } = require('../../../package.json');

export function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  } catch {
    return false;
  }
}

export function buildMcpServer({ root, fullAccess = false, permissions }) {
  const runtime = createRuntime({ root, fullAccess, permissions });
  const server = new McpServer({ name: 'buildifyx-desktop-agent', version: packageVersion });
  registerMcpTools(server, runtime.dispatch, { fullAccess });
  return { server, runtime };
}

export async function startMcpServer({ root, port, fullAccess = false, permissions }) {
  const handler = createMcpHandler(() => buildMcpServer({ root, fullAccess, permissions }).server, {
    responseMode: 'json'
  });
  const nodeHandler = toNodeHandler(handler);

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: packageVersion, mode: fullAccess ? 'full_access' : 'restricted' }));
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
  console.log(`Version: ${packageVersion}`);
  console.log(`Root:    ${root}`);
  console.log(`MCP:     http://127.0.0.1:${port}/mcp`);
  console.log(`Health:  http://127.0.0.1:${port}/health`);
  console.log(`Mode:    ${fullAccess ? 'FULL ACCESS (not sandboxed)' : 'restricted'}`);
  if (fullAccess) console.log('Warning: commands may access anything available to the current OS user.');

  async function close() {
    await handler.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }

  return { close, httpServer };
}
