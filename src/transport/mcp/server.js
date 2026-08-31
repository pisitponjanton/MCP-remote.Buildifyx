import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createRuntime } from '../../core/runtime.js';
import { createToolManifest, registerMcpToolRegistry } from './tools/index.js';
import { inspectToolManifest } from './manifest-store.js';

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

export function buildMcpServer({ runtime, root, fullAccess = false, policy, manifest }) {
  const activeRuntime = runtime ?? createRuntime({ root, fullAccess, policy });
  const activeManifest = manifest ?? createToolManifest({ fullAccess: activeRuntime.fullAccess });
  const server = new McpServer({ name: 'buildifyx-desktop-agent', version: packageVersion });
  registerMcpToolRegistry(server, activeRuntime.dispatch, { fullAccess: activeRuntime.fullAccess });
  return { server, runtime: activeRuntime, manifest: activeManifest };
}

export async function startMcpServer({ root, port, fullAccess = false, policy, runtime, quiet = false }) {
  const activeRuntime = runtime ?? createRuntime({ root, fullAccess, policy });
  const manifest = createToolManifest({ fullAccess: activeRuntime.fullAccess });
  const manifestState = await inspectToolManifest(manifest);

  const handler = createMcpHandler(() => buildMcpServer({ runtime: activeRuntime, manifest }).server, {
    responseMode: 'json'
  });
  const nodeHandler = toNodeHandler(handler);

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        version: packageVersion,
        mode: activeRuntime.fullAccess ? 'full_access' : 'restricted',
        tools: {
          count: manifest.count,
          hash: manifest.hash,
          shortHash: manifest.shortHash,
          changedSinceLastRun: manifestState.changed
        }
      }));
      return;
    }

    if (url.pathname === '/tools' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        version: packageVersion,
        changedSinceLastRun: manifestState.changed,
        previousHash: manifestState.previousHash,
        ...manifest
      }, null, 2));
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

  if (!quiet) {
    console.log('Buildifyx Desktop Agent');
    console.log(`Version: ${packageVersion}`);
    console.log(`Root:    ${root}`);
    console.log(`MCP:     http://127.0.0.1:${port}/mcp`);
    console.log(`Health:  http://127.0.0.1:${port}/health`);
    console.log(`Tools:   ${manifest.count} (${manifest.shortHash})${manifestState.changed ? ' CHANGED' : ''}`);
    console.log(`Mode:    ${activeRuntime.fullAccess ? 'FULL ACCESS (not sandboxed)' : 'restricted'}`);
  }

  async function close() {
    await handler.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }

  return {
    close,
    httpServer,
    runtime: activeRuntime,
    version: packageVersion,
    manifest,
    manifestState,
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    healthUrl: `http://127.0.0.1:${port}/health`,
    toolsUrl: `http://127.0.0.1:${port}/tools`
  };
}
