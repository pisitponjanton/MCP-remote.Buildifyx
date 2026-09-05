import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { buildifyxHome } from './home.js';

const DEFAULT_INSTANCES_DIR = path.join(buildifyxHome(), 'instances');

export function instanceControlPath(instanceId, directory = DEFAULT_INSTANCES_DIR) {
  const key = createHash('sha256').update(String(instanceId)).digest('hex').slice(0, 20);
  if (process.platform === 'win32') return `\\\\.\\pipe\\bdxa-${key}`;
  return path.join(directory, `ctl-${key}.sock`);
}

export async function startInstanceControl({ instanceId, directory = DEFAULT_INSTANCES_DIR, metadata = {}, onShutdown, onForce, onCommand }) {
  await mkdir(directory, { recursive: true });
  const endpoint = instanceControlPath(instanceId, directory);
  if (process.platform !== 'win32') await rm(endpoint, { force: true }).catch(() => undefined);

  const server = net.createServer((socket) => {
    let buffer = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      if (handled) return;
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      handled = true;
      const raw = buffer.slice(0, newline);

      let message;
      try { message = JSON.parse(raw); } catch {
        socket.end(`${JSON.stringify({ ok: false, error: 'INVALID_REQUEST' })}\n`);
        return;
      }

      // Discovery is intentionally limited to non-secret local instance metadata.
      // The Unix control socket itself is chmod 0600, and Windows named pipes are
      // scoped to the local machine. This allows bdxa to recover an orphaned
      // process even if its JSON registry/name lock was accidentally removed.
      if (message.command === 'identify') {
        socket.end(`${JSON.stringify({ ok: true, instanceId, pid: process.pid, ...metadata })}\n`);
        return;
      }

      if (message?.instanceId !== instanceId) {
        socket.end(`${JSON.stringify({ ok: false, error: 'INSTANCE_MISMATCH' })}\n`);
        return;
      }

      if (message.command === 'ping') {
        socket.end(`${JSON.stringify({ ok: true, instanceId, pid: process.pid })}\n`);
        return;
      }

      if (message.command === 'shutdown') {
        socket.end(`${JSON.stringify({ ok: true, instanceId, stopping: true })}\n`);
        setImmediate(() => { void onShutdown?.(message); });
        return;
      }

      if (message.command === 'force') {
        socket.end(`${JSON.stringify({ ok: true, instanceId, forcing: true })}\n`);
        setImmediate(() => {
          if (onForce) void onForce();
          else process.exit(1);
        });
        return;
      }

      if (onCommand) {
        try {
          const response = await onCommand(message);
          if (response !== undefined) {
            socket.end(`${JSON.stringify({ ok: true, instanceId, ...response })}\n`);
            return;
          }
        } catch (error) {
          socket.end(`${JSON.stringify({ ok: false, instanceId, error: error?.message ?? String(error), code: error?.code, details: error?.details })}\n`);
          return;
        }
      }

      socket.end(`${JSON.stringify({ ok: false, error: 'UNKNOWN_COMMAND' })}\n`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (process.platform !== 'win32') await chmod(endpoint, 0o600).catch(() => undefined);

  let closed = false;
  return {
    endpoint,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => server.close(() => resolve()));
      if (process.platform !== 'win32') await rm(endpoint, { force: true }).catch(() => undefined);
    }
  };
}

function requestControlEndpoint(endpoint, payload, timeoutMs = 1000, signal = null) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = '';
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => {
      socket.destroy();
      finish(() => reject(Object.assign(new Error('Instance control request aborted'), { code: 'INSTANCE_CONTROL_ABORTED' })));
    };
    const timeout = setTimeout(() => {
      socket.destroy();
      finish(() => reject(Object.assign(new Error('Instance control request timed out'), { code: 'INSTANCE_CONTROL_TIMEOUT' })));
    }, timeoutMs);

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    socket.setEncoding('utf8');
    socket.once('error', (error) => finish(() => reject(error)));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const raw = buffer.slice(0, newline);
      socket.end();
      finish(() => {
        try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
      });
    });
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
  });
}

export async function identifyInstanceControl(endpoint, { timeoutMs = 500 } = {}) {
  return requestControlEndpoint(endpoint, { command: 'identify' }, timeoutMs);
}

export async function requestInstanceControl(record, command, { timeoutMs = 1000, payload = {}, signal = null } = {}) {
  const endpoint = record.controlPath || instanceControlPath(record.instanceId);
  return requestControlEndpoint(endpoint, { command, instanceId: record.instanceId, ...payload }, timeoutMs, signal);
}

export async function probeInstanceControl(record, options) {
  try {
    const response = await requestInstanceControl(record, 'ping', options);
    return Boolean(response?.ok && response.instanceId === record.instanceId && response.pid === record.pid);
  } catch {
    return false;
  }
}
