import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { normalizeError, publicToolError } from '../core/errors.js';
import { parseMcpToolInput } from './mcp/tools/registry.js';
import { createCloudMediaBridge } from './media/cloud-bridge.js';
import { createMediaTransferPermission } from './media/access-policy.js';
import { createCloudImageImportReceiver } from './media/inbound.js';

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
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function safeSendAsync(socket, payload) {
  return new Promise((resolve, reject) => {
    if (socket?.readyState !== WebSocket.OPEN) {
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
  const socketGenerations = new WeakMap();
  const mediaAllowed = createMediaTransferPermission({
    getCategories: () => runtime.policyManager?.get()?.categories,
    isCaptureArtifact: (artifactId) => runtime.services.__artifactRequiresCapture(artifactId)
  });
  const media = createCloudMediaBridge({ instanceId: instance.instanceId,
    readImage: (id) => runtime.services.__readImageBytes(id, { screenshotApproved: true }),
    canTransfer: (tool, result) => mediaAllowed({ tool, artifactId: result.artifactId }),
    send: (message) => safeSendAsync(socket, message) });
  const inbound=createCloudImageImportReceiver({
    instanceId:instance.instanceId,
    send:(message)=>safeSendAsync(socket,message),
    storeImage:(bytes)=>runtime.services.__importCloudImage(bytes),
    clearImages:()=>runtime.services?.__clearCloudImports?.(),
    canImport:()=> {
      const categories=runtime.policyManager?.get()?.categories ?? {};
      return categories.imageRead==='allow' && categories.cacheManage==='allow';
    },
    current:(source)=>socket?.readyState===WebSocket.OPEN && (!source || source===socket)
  });
  let stopped = false;
  const activeMedia = new Map();
  const activeCalls = new Set();
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

  async function handleManagementCall(message, sourceSocket) {
    if (!message.requestId || typeof message.action !== 'string' || !message.action) return;
    if (message.instanceId && message.instanceId !== instance.instanceId) {
      safeSend(sourceSocket, {
        type: 'management.error',
        requestId: message.requestId,
        instanceId: instance.instanceId,
        error: { code: 'INSTANCE_MISMATCH', message: 'Management request was routed to the wrong bdxa instance.' }
      });
      return;
    }
    if (!managementHandler) {
      safeSend(sourceSocket, {
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
        instanceId: instance.instanceId,
        // Captured socket identity is a generation fence. The handler checks
        // this at the policy commit boundary, not merely when the RPC arrives.
        assertCurrent: () => sourceSocket === socket && sourceSocket?.readyState === WebSocket.OPEN,
        remoteGeneration: socketGenerations.get(sourceSocket)
      });
      const envelope = handled && typeof handled === 'object' && ('result' in handled || 'afterSend' in handled)
        ? handled
        : { result: handled };
      await safeSendAsync(sourceSocket, {
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
      safeSend(sourceSocket, {
        type: 'management.error',
        requestId: message.requestId,
        instanceId: instance.instanceId,
        error: { code: normalized.code, message: normalized.message, details: normalized.details }
      });
    }
  }

  async function handleMessage(raw, sourceSocket) {
    // Ignore late frames from the previous authenticated connection.
    if(sourceSocket !== socket || sourceSocket?.readyState !== WebSocket.OPEN) return;
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }

    if (message.type === 'media.capabilities.accept') {
      const ok=media.acceptCapabilities(message);
      inbound.accept(ok && message.features?.includes('image-import-v1'));
      return;
    }
    if (inbound.receive(message,sourceSocket))return;
    if (media.receive(message)) return;
    if (message.type === 'ping') {
      safeSend(sourceSocket, { type: 'pong', instanceId: instance.instanceId, timestamp: new Date().toISOString() });
      return;
    }
    if (message.type === 'media.transfer.cancel' && message.instanceId === instance.instanceId && typeof message.requestId === 'string') {
      activeMedia.get(message.requestId)?.abort();
      return;
    }
    if (message.type === 'tool.cancel' && message.requestId) {
      activeMedia.get(message.requestId)?.abort();
      runtime.cancel?.(message.requestId, message.reason ?? 'Cloud request was cancelled');
      return;
    }

    if (message.type === 'management.call') {
      await handleManagementCall(message, sourceSocket);
      return;
    }

    if (message.type !== 'tool.call' || !message.requestId || !message.tool) return;

    if (message.instanceId && message.instanceId !== instance.instanceId) {
      safeSend(sourceSocket, {
        type: 'tool.error',
        requestId: message.requestId,
        instanceId: instance.instanceId,
        error: { code: 'INSTANCE_MISMATCH', message: 'Tool call was routed to the wrong bdxa instance.' }
      });
      return;
    }

    // Request IDs are unique while in flight. A duplicate must never reach
    // dispatch or own a finally handler for the original call: otherwise it
    // can erase the first call's active entry and prevent disconnect cancel.
    // Do not reply with tool.error using the same ID; the Cloud could attach
    // that response to the original pending tool call. Fail closed instead.
    if (activeCalls.has(message.requestId)) {
      sourceSocket.close(1008, 'Duplicate tool request ID');
      return;
    }
    eventBus?.emit('cloud.tool.received', { requestId: message.requestId, tool: message.tool, instanceId: instance.instanceId });
    activeCalls.add(message.requestId);
    try {
      const input = parseMcpToolInput(message.tool, message.arguments ?? {});
      const result = await runtime.dispatch(message.tool, input, { requestId: message.requestId });
      const controller = new AbortController();
      activeMedia.set(message.requestId, controller);
      let transfer;
      try { transfer = await media.sendImage(message.tool, result, message.requestId, controller.signal); }
      finally { activeMedia.delete(message.requestId); }
      const delivered = transfer ? { ...result, mediaTransfer: transfer, imageBytesDelivered: false,
        message: 'Cloud relay acknowledged bytes; client ImageContent delivery requires Cloud implementation.' } : result;
      safeSend(sourceSocket, { type: 'tool.result', requestId: message.requestId, instanceId: instance.instanceId, result: delivered });
    } catch (error) {
      const normalized = publicToolError(error);
      safeSend(sourceSocket, {
        type: 'tool.error',
        requestId: message.requestId,
        instanceId: instance.instanceId,
        error: { code: normalized.code, message: normalized.message, details: normalized.details }
      });
    } finally {
      activeCalls.delete(message.requestId);
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

    const connectionSocket=socket;
    connectionSocket.on('open', () => {
      void (async () => {
      if(socket!==connectionSocket)return;
      const claim = runtime.policyManager?.claimRemoteGeneration;
      if (typeof claim === 'function') {
        const generation = randomUUID();
        await claim(generation, () => {
          if (socket !== connectionSocket || connectionSocket.readyState !== WebSocket.OPEN)
            throw new Error('Remote management session replaced before generation claim.');
        });
        if (socket !== connectionSocket || connectionSocket.readyState !== WebSocket.OPEN) return;
        socketGenerations.set(connectionSocket, generation);
      }
      media.reset();
      inbound.reset();
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
        toolManifest: {
          count: manifest.count,
          hash: manifest.hash,
          manifestVersion: manifest.manifestVersion,
          ...(Array.isArray(manifest.tools) ? { names: manifest.tools.map((tool) => tool.name) } : {})
        },
        capabilities: {
          ...(managementHandler ? {
            managementVersion: MANAGEMENT_PROTOCOL_VERSION,
            actions: [...new Set(managementCapabilities)],
            ...(socketGenerations.has(connectionSocket) ? { permissionFencing: 'policy-file-v1' } : {})
          } : {}),
          media: media.advertised
        }
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
      })().catch((error) => {
        if (socket !== connectionSocket) return;
        setState({ lastError: error?.message ?? String(error) });
        connectionSocket.close(1011, 'Remote permission generation unavailable');
      });
    });

    connectionSocket.on('message', (raw) => { void handleMessage(raw, connectionSocket); });
    connectionSocket.on('error', (error) => {
      if(socket===connectionSocket)setState({ lastError: error.message });
    });
    connectionSocket.on('close', (code, reason) => {
      if(socket!==connectionSocket)return;
      // Cancel tools still awaiting approval or browser launch, not just media
      // transfers. This fences browser sessions from appearing after disconnect.
      for (const requestId of activeCalls) runtime.cancel?.(requestId, 'Cloud connection closed');
      for (const controller of activeMedia.values()) controller.abort();
      activeMedia.clear();
      media.stop();
      inbound.reset();
      // Cloud sessions must not retain a remotely controlled browser after the
      // authenticated socket goes away. Persistent profile files remain local.
      void runtime.services?.closeActive?.().catch(error => {
        eventBus?.emit('cloud.browser.cleanup.failed', { instanceId: instance.instanceId, code: error?.code ?? 'BROWSER_CLEANUP_FAILED' });
      });
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
    for (const controller of activeMedia.values()) controller.abort();
    activeMedia.clear();
    media.stop();
    inbound.stop();
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
