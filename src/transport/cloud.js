import WebSocket from 'ws';
import { normalizeError } from '../core/errors.js';
import { parseMcpToolInput } from './mcp/tools/registry.js';

export const DEFAULT_CLOUD_ORIGIN = 'https://bdxa.buildifyx.com';
export const AGENT_PROTOCOL_VERSION = 2;
export const MANAGEMENT_PROTOCOL_VERSION = 1;
export const MAX_CLOUD_FRAME_BYTES = 4 * 1024 * 1024;
function isLoopbackHostname(hostname) {
  const value = String(hostname ?? '').toLowerCase();
  return value === 'localhost' || value.endsWith('.localhost') || value === '::1' || value === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(value);
}

export function normalizeCloudOrigin(value = DEFAULT_CLOUD_ORIGIN) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Cloud URL must use http or https.');
  if (url.username || url.password) throw new Error('Cloud URL must not include embedded credentials.');
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new Error('Cloud URL must use https. Plain http is allowed only for localhost development endpoints.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function getCloudEndpoints(origin = DEFAULT_CLOUD_ORIGIN) {
  const normalized = normalizeCloudOrigin(origin);
  const http = new URL(normalized);
  const ws = new URL(normalized);
  ws.protocol = http.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    origin: normalized,
    loginUrl: new URL('/api/auth/device-login', http).toString(),
    meUrl: new URL('/api/device/me', http).toString(),
    logoutUrl: new URL('/api/device/logout', http).toString(),
    agentUrl: new URL('/agent', ws).toString()
  };
}

async function parseJsonResponse(response) {
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { message: text }; }
  }
  if (!response.ok) {
    const message = body?.error?.message ?? body?.message ?? `Cloud request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function loginDevice({ cloudUrl = DEFAULT_CLOUD_ORIGIN, token, device, signal }) {
  const { loginUrl } = getCloudEndpoints(cloudUrl);
  const response = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ token, device }),
    signal
  });
  return parseJsonResponse(response);
}

export async function getDeviceMe({ cloudUrl = DEFAULT_CLOUD_ORIGIN, deviceToken, signal }) {
  const { meUrl } = getCloudEndpoints(cloudUrl);
  const response = await fetch(meUrl, {
    headers: { authorization: `Bearer ${deviceToken}`, accept: 'application/json' },
    signal
  });
  return parseJsonResponse(response);
}

export async function logoutDevice({ cloudUrl = DEFAULT_CLOUD_ORIGIN, deviceToken, signal }) {
  const { logoutUrl } = getCloudEndpoints(cloudUrl);
  const response = await fetch(logoutUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${deviceToken}`, accept: 'application/json' },
    signal
  });
  if (response.status === 204) return null;
  return parseJsonResponse(response);
}

function safeSend(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function safeSendAsync(socket, payload) {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('Cloud socket is not open.'));
      return;
    }
    socket.send(JSON.stringify(payload), (error) => error ? reject(error) : resolve());
  });
}

export function createCloudAgent({
  cloudUrl = DEFAULT_CLOUD_ORIGIN,
  credentials,
  runtime,
  manifest,
  version,
  instance,
  deviceInfo,
  eventBus,
  managementHandler = null,
  managementCapabilities = [],
  heartbeatMs = 30_000,
  reconnect = true
}) {
  const endpoint = getCloudEndpoints(cloudUrl).agentUrl;
  let socket = null;
  let stopped = false;
  let heartbeat = null;
  let retryTimer = null;
  let retryAttempt = 0;
  const listeners = new Set();
  let state = { status: 'disconnected', endpoint, instanceId: instance.instanceId, retryAttempt: 0, lastError: null };

  function setState(patch) {
    state = { ...state, ...patch };
    eventBus?.emit('cloud.connection', state);
    for (const listener of listeners) listener({ ...state });
  }

  function scheduleReconnect() {
    if (stopped || !reconnect || retryTimer) return;
    const delays = [1000, 2000, 5000, 10_000, 30_000];
    const delay = delays[Math.min(retryAttempt, delays.length - 1)];
    retryAttempt += 1;
    setState({ status: 'reconnecting', retryAttempt, retryInMs: delay });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  async function handleManagementCall(message) {
    if (!message.requestId || typeof message.action !== 'string' || !message.action) return;
    if (message.instanceId && message.instanceId !== instance.instanceId) {
      safeSend(socket, {
        type: 'management.error',
        requestId: message.requestId,
        instanceId: instance.instanceId,
        error: { code: 'INSTANCE_MISMATCH', message: 'Management request was routed to the wrong bdxa instance.' }
      });
      return;
    }
    if (!managementHandler) {
      safeSend(socket, {
        type: 'management.error',
        requestId: message.requestId,
        instanceId: instance.instanceId,
        error: { code: 'MANAGEMENT_UNSUPPORTED', message: 'This bdxa version does not support remote management.' }
      });
      return;
    }

    try {
      const handled = await managementHandler(message.action, message.arguments ?? {}, {
        requestId: message.requestId,
        instanceId: instance.instanceId
      });
      const envelope = handled && typeof handled === 'object' && ('result' in handled || 'afterSend' in handled)
        ? handled
        : { result: handled };
      await safeSendAsync(socket, {
        type: 'management.result',
        requestId: message.requestId,
        instanceId: instance.instanceId,
        result: envelope.result ?? null
      });
      if (typeof envelope.afterSend === 'function') {
        setImmediate(() => {
          Promise.resolve(envelope.afterSend()).catch((error) => setState({ lastError: error?.message ?? String(error) }));
        });
      }
    } catch (error) {
      const normalized = normalizeError(error);
      safeSend(socket, {
        type: 'management.error',
        requestId: message.requestId,
        instanceId: instance.instanceId,
        error: { code: normalized.code, message: normalized.message, details: normalized.details }
      });
    }
  }

  async function handleMessage(raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }

    if (message.type === 'ping') {
      safeSend(socket, { type: 'pong', instanceId: instance.instanceId, timestamp: new Date().toISOString() });
      return;
    }

    if (message.type === 'tool.cancel' && message.requestId) {
      runtime.cancel?.(message.requestId, message.reason ?? 'Cloud request was cancelled');
      return;
    }

    if (message.type === 'management.call') {
      await handleManagementCall(message);
      return;
    }

    if (message.type !== 'tool.call' || !message.requestId || !message.tool) return;

    if (message.instanceId && message.instanceId !== instance.instanceId) {
      safeSend(socket, {
        type: 'tool.error',
        requestId: message.requestId,
        instanceId: instance.instanceId,
        error: { code: 'INSTANCE_MISMATCH', message: 'Tool call was routed to the wrong bdxa instance.' }
      });
      return;
    }

    eventBus?.emit('cloud.tool.received', { requestId: message.requestId, tool: message.tool, instanceId: instance.instanceId });
    try {
      const input = parseMcpToolInput(message.tool, message.arguments ?? {});
      const result = await runtime.dispatch(message.tool, input, { requestId: message.requestId });
      safeSend(socket, { type: 'tool.result', requestId: message.requestId, instanceId: instance.instanceId, result });
    } catch (error) {
      const normalized = normalizeError(error);
      safeSend(socket, {
        type: 'tool.error',
        requestId: message.requestId,
        instanceId: instance.instanceId,
        error: { code: normalized.code, message: normalized.message, details: normalized.details }
      });
    }
  }

  function connect() {
    if (stopped) return;
    if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
    setState({ status: 'connecting', endpoint, lastError: null });
    socket = new WebSocket(endpoint, {
      maxPayload: MAX_CLOUD_FRAME_BYTES,
      headers: {
        authorization: `Bearer ${credentials.deviceToken}`,
        'user-agent': `buildifyx-desktop-agent/${version}`
      }
    });

    socket.on('open', () => {
      retryAttempt = 0;
      setState({ status: 'connected', retryAttempt: 0, retryInMs: null, connectedAt: new Date().toISOString() });
      safeSend(socket, {
        type: 'device.ready',
        protocolVersion: AGENT_PROTOCOL_VERSION,
        deviceId: credentials.deviceId,
        instanceId: instance.instanceId,
        workspace: { name: instance.name, path: instance.path },
        mode: instance.mode,
        agentVersion: version,
        device: deviceInfo,
        toolManifest: { count: manifest.count, hash: manifest.hash, manifestVersion: manifest.manifestVersion },
        ...(managementHandler ? {
          capabilities: {
            managementVersion: MANAGEMENT_PROTOCOL_VERSION,
            actions: [...new Set(managementCapabilities)]
          }
        } : {})
      });
      clearInterval(heartbeat);
      heartbeat = setInterval(() => safeSend(socket, {
        type: 'device.heartbeat',
        protocolVersion: AGENT_PROTOCOL_VERSION,
        deviceId: credentials.deviceId,
        instanceId: instance.instanceId,
        timestamp: new Date().toISOString()
      }), heartbeatMs);
      heartbeat.unref?.();
    });

    socket.on('message', (raw) => { void handleMessage(raw); });
    socket.on('error', (error) => setState({ lastError: error.message }));
    socket.on('close', (code, reason) => {
      clearInterval(heartbeat);
      heartbeat = null;
      socket = null;
      const closeReason = reason.toString() || null;
      if (code === 4003 || code === 4004) {
        stopped = true;
        setState({ status: 'revoked', closeCode: code, closeReason, lastError: closeReason });
        return;
      }
      setState({ status: 'disconnected', closeCode: code, closeReason });
      scheduleReconnect();
    });
  }

  async function stop() {
    stopped = true;
    clearInterval(heartbeat);
    clearTimeout(retryTimer);
    heartbeat = null;
    retryTimer = null;
    if (!socket) {
      setState({ status: 'stopped' });
      return;
    }
    await new Promise((resolve) => {
      const active = socket;
      const timeout = setTimeout(resolve, 1000);
      active.once('close', () => { clearTimeout(timeout); resolve(); });
      active.close(1000, 'agent shutdown');
    });
    socket = null;
    setState({ status: 'stopped' });
  }

  return {
    endpoint,
    connect,
    stop,
    getState: () => ({ ...state }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}
