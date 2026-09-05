import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { listInstances } from '../utils/instances.js';
import { requestInstanceControl } from '../utils/instance-control.js';
import { getMcpToolDefinitions } from '../transport/mcp/tools/registry.js';
import { errorResult, successResult } from '../transport/mcp/response.js';
import { resolveWorkspaceTarget, selectedTarget, workspaceSummary } from './workspace-routing.js';
import { AgentError, ErrorCode } from '../core/errors.js';

const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
const LOCAL_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000;
const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const targetIdSelector = z.string().min(1).max(512).optional();
const workspaceSelector = z.string().min(1).max(256).optional();
const deviceSelector = z.string().min(1).max(256).optional();
const routingFields = { targetId: targetIdSelector, workspace: workspaceSelector, device: deviceSelector };

function isLoopbackName(value) {
  const host = String(value ?? '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
}

export function isAllowedLocalRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return isLoopbackName(new URL(origin).hostname); } catch { return false; }
}

export function createLocalGateway({ environment, version, gatewayId, controlToken }) {
  const sessions = new Map();

  async function availableTargets() {
    const instances = await listInstances(environment.instancesDirectory, { transport: environment.kind });
    return instances.filter((item) => item.live && item.verified && !item.processOnly).map((item) => {
      const deviceName = item.deviceName ?? os.hostname();
      return {
        targetId: `local:${item.instanceId}`,
        deviceId: deviceName,
        instanceId: item.instanceId,
        name: item.name,
        path: item.workspace,
        mode: item.mode,
        agentVersion: item.agentVersion ?? version,
        deviceName,
        record: item
      };
    });
  }

  async function runTool(session, definition, args, context = {}) {
    const tool = definition.name;
    let target = null;
    let requestId = null;
    try {
      const { targetId, workspace, device, ...toolArgs } = args ?? {};
      const selector = targetId || workspace || device
        ? { targetId, workspace, device }
        : session.target ? { targetId: session.target.targetId } : {};
      target = resolveWorkspaceTarget(await availableTargets(), selector);
      session.target = selectedTarget(target);
      requestId = `local_${randomUUID()}`;
      const timeoutMs = LOCAL_TOOL_CALL_TIMEOUT_MS;
      let cancelSent = false;
      const sendCancel = async (reason) => {
        if (cancelSent || !target || !requestId) return;
        cancelSent = true;
        await requestInstanceControl(target.record, 'tool.cancel', {
          timeoutMs: 1000,
          payload: { requestId, reason }
        }).catch(() => undefined);
      };
      const signal = context.mcpReq?.signal ?? context.signal ?? null;
      const onAbort = () => { void sendCancel('Local MCP request was cancelled by the client.'); };
      signal?.addEventListener('abort', onAbort, { once: true });
      let response;
      try {
        response = await requestInstanceControl(target.record, 'tool.call', {
          timeoutMs,
          signal,
          payload: { requestId, tool, arguments: toolArgs }
        });
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      if (!response?.ok) throw Object.assign(new Error(response?.error ?? 'Local instance tool call failed.'), { code: response?.code });
      const result = response.result;
      return definition.toMcpResult
        ? definition.toMcpResult(result)
        : successResult(result);
    } catch (error) {
      if (target && requestId && error?.code === 'INSTANCE_CONTROL_TIMEOUT') {
        await requestInstanceControl(target.record, 'tool.cancel', {
          timeoutMs: 1000,
          payload: { requestId, reason: 'Local MCP tool request timed out waiting for completion.' }
        }).catch(() => undefined);
      }
      if (error?.code === 'INSTANCE_CONTROL_ABORTED') return errorResult(new AgentError(ErrorCode.REQUEST_CANCELLED, 'Local MCP request was cancelled by the client.'));
      return errorResult(error);
    }
  }

  function buildServer(session) {
    const server = new McpServer({ name: 'buildifyx-desktop-agent-local', version });

    server.registerTool('list_workspaces', {
      title: 'List Buildifyx workspaces',
      description: 'List every online local Buildifyx workspace available through this local gateway.',
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations
    }, async () => {
      const targets = await availableTargets();
      const workspaces = targets.map((target) => workspaceSummary(target, session.target));
      const devices = workspaces.length ? [{ id: os.hostname(), name: os.hostname(), workspaces }] : [];
      const result = { workspaces, devices, selectedTargetId: session.target?.targetId ?? null, selectedWorkspace: session.target?.targetId ?? null };
      return successResult(result);
    });

    server.registerTool('use_workspace', {
      title: 'Select Buildifyx workspace',
      description: 'Select the exact local workspace this MCP session should use. Prefer targetId from list_workspaces.',
      inputSchema: z.object(routingFields),
      annotations: readOnlyAnnotations
    }, async ({ targetId, workspace, device }) => {
      try {
        if (!targetId && !workspace && !device) throw Object.assign(new Error('Specify targetId, workspace, or device.'), { code: 'INVALID_WORKSPACE_SELECTOR' });
        const target = resolveWorkspaceTarget(await availableTargets(), { targetId, workspace, device });
        session.target = selectedTarget(target);
        const selected = workspaceSummary(target, session.target);
        return successResult({ selected });
      } catch (error) {
        return errorResult(error);
      }
    });

    for (const definition of getMcpToolDefinitions()) {
      const config = {
        title: definition.title,
        description: definition.description,
        annotations: definition.annotations
      };
      config.inputSchema = definition.inputSchema
        ? z.intersection(z.object(routingFields), definition.inputSchema)
        : z.object(routingFields);
      server.registerTool(definition.name, config, (args = {}, context = {}) => runTool(session, definition, args, context));
    }
    return server;
  }

  function pruneSessions(now = Date.now()) {
    for (const [id, active] of sessions) {
      if (now - active.lastSeenAt <= SESSION_IDLE_MS) continue;
      sessions.delete(id);
      void active.transport.close().catch(() => undefined);
    }
  }

  async function handleMcp(req, res) {
    pruneSessions();
    const sessionId = Array.isArray(req.headers['mcp-session-id']) ? req.headers['mcp-session-id'][0] : req.headers['mcp-session-id'];
    if (sessionId) {
      const active = sessions.get(sessionId);
      if (!active) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'MCP_SESSION_NOT_FOUND' }));
        return;
      }
      active.lastSeenAt = Date.now();
      await active.transport.handleRequest(req, res);
      return;
    }

    const session = { target: null };
    const server = buildServer(session);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => `mcp_${randomUUID()}`, enableJsonResponse: true });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    await server.connect(transport);
    await transport.handleRequest(req, res);
    if (transport.sessionId) sessions.set(transport.sessionId, { server, transport, session, lastSeenAt: Date.now() });
    else await transport.close().catch(() => undefined);
  }

  let httpServer = null;
  let closing = false;

  async function close() {
    if (closing) return;
    closing = true;
    const activeSessions = [...sessions.values()];
    sessions.clear();
    await Promise.all(activeSessions.map((active) => active.transport.close().catch(() => undefined)));
    if (httpServer) await new Promise((resolve) => httpServer.close(() => resolve()));
  }

  async function start(port) {
    httpServer = createServer((req, res) => {
      void (async () => {
        if (!isAllowedLocalRequest(req)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'LOCAL_REQUEST_FORBIDDEN' }));
          return;
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, gatewayId, version, pid: process.pid, port }));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/_bdxa/shutdown') {
          if (req.headers['x-bdxa-control-token'] !== controlToken) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'FORBIDDEN' }));
            return;
          }
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, stopping: true }));
          setImmediate(() => { void close(); });
          return;
        }
        if (url.pathname === '/mcp') {
          await handleMcp(req, res);
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND' }));
      })().catch((error) => {
        if (res.headersSent) return res.end();
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error?.message ?? String(error) }));
      });
    });

    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, '127.0.0.1', () => {
        httpServer.off('error', reject);
        resolve();
      });
    });
    return {
      port,
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      healthUrl: `http://127.0.0.1:${port}/health`,
      close
    };
  }

  return { start, close, availableTargets };
}
