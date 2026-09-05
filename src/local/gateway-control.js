import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_LOCAL_PORT = 3333;

export function localGatewayLockPath(environment) {
  return path.join(environment.rootDirectory, 'gateway.lock');
}

export function localGatewayStartupPath(environment) {
  return path.join(environment.rootDirectory, 'gateway-startup.json');
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

async function writePrivateJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}
`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
  return value;
}

export async function readLocalGatewayStartup(environment) {
  try { return JSON.parse(await readFile(localGatewayStartupPath(environment), 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function removeLocalGatewayStartup(environment) {
  await rm(localGatewayStartupPath(environment), { force: true });
}

async function acquireGatewayStartupLock(environment, timeoutMs = 15_000) {
  const filePath = localGatewayLockPath(environment);
  const lockId = `lock_${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  await mkdir(environment.rootDirectory, { recursive: true, mode: 0o700 });

  while (Date.now() < deadline) {
    try {
      const handle = await open(filePath, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify({ lockId, pid: process.pid, createdAt: new Date().toISOString() })}
`, 'utf8'); }
      finally { await handle.close(); }
      return async () => {
        try {
          const current = JSON.parse(await readFile(filePath, 'utf8'));
          if (current?.lockId === lockId) await rm(filePath, { force: true });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const current = JSON.parse(await readFile(filePath, 'utf8'));
        const createdAt = Date.parse(current?.createdAt ?? '');
        stale = !isPidAlive(current?.pid) || (Number.isFinite(createdAt) && Date.now() - createdAt > 30_000);
      } catch {
        try { stale = Date.now() - (await stat(filePath)).mtimeMs > 10_000; } catch { stale = true; }
      }
      if (stale) {
        await rm(filePath, { force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }
  throw new Error('Timed out waiting for another local gateway startup to finish.');
}

export function localGatewayChildArgs({ cliEntry, port, gatewayId }) {
  return [cliEntry, '__local-gateway', '--port', String(port), '--gateway-id', gatewayId];
}

export function localGatewayStatePath(environment) {
  return path.join(environment.rootDirectory, 'gateway.json');
}

export function localGatewayLogPath(environment) {
  return path.join(environment.rootDirectory, 'gateway.log');
}

export function localGatewayConfigPath(environment) {
  return path.join(environment.rootDirectory, 'gateway-config.json');
}

export function parseLocalPort(value = DEFAULT_LOCAL_PORT) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid local gateway port: ${value}`);
  return port;
}


export async function readLocalGatewayConfig(environment) {
  try {
    const parsed = JSON.parse(await readFile(localGatewayConfigPath(environment), 'utf8'));
    return { port: parseLocalPort(parsed?.port ?? DEFAULT_LOCAL_PORT) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { port: DEFAULT_LOCAL_PORT };
    throw error;
  }
}

export async function writeLocalGatewayConfig(environment, config) {
  const filePath = localGatewayConfigPath(environment);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const value = { version: 1, port: parseLocalPort(config?.port ?? DEFAULT_LOCAL_PORT) };
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}
`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
  return value;
}

export async function readLocalGatewayState(environment) {
  try { return JSON.parse(await readFile(localGatewayStatePath(environment), 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeLocalGatewayState(environment, state) {
  const filePath = localGatewayStatePath(environment);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
  return state;
}

export async function removeLocalGatewayState(environment) {
  await rm(localGatewayStatePath(environment), { force: true });
}

async function fetchHealth(state, timeoutMs = 700) {
  if (!state?.port || !state?.gatewayId) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.ok && body.gatewayId === state.gatewayId ? body : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

export async function getLocalGatewayStatus(environment) {
  const state = await readLocalGatewayState(environment);
  if (!state) return { running: false, state: null, health: null };
  const health = await fetchHealth(state);
  if (!health) return { running: false, state, health: null };
  return { running: true, state, health };
}

async function waitForGateway(environment, gatewayId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await getLocalGatewayStatus(environment);
    if (status.running && status.state.gatewayId === gatewayId) return status;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return null;
}

export async function startLocalGateway({ environment, cliEntry, port = DEFAULT_LOCAL_PORT, version }) {
  const releaseLock = await acquireGatewayStartupLock(environment);
  try {
    const requestedPort = parseLocalPort(port);
    const current = await getLocalGatewayStatus(environment);
    if (current.running) {
      if (current.state.port !== requestedPort) {
        throw new Error(`Local gateway is already running on port ${current.state.port}. Run \`bdxa local down\` before changing ports.`);
      }
      return { ...current, alreadyRunning: true };
    }
    if (current.state) await removeLocalGatewayState(environment);
    if (!cliEntry) throw new Error('Could not determine the bdxa CLI entrypoint for local gateway startup.');

    await mkdir(environment.rootDirectory, { recursive: true, mode: 0o700 });
    const gatewayId = `localgw_${randomUUID()}`;
    const controlToken = randomBytes(32).toString('hex');
    const logPath = localGatewayLogPath(environment);
    const handle = await open(logPath, 'a', 0o600);
    let child = null;
    try {
      await writePrivateJson(localGatewayStartupPath(environment), {
        version: 1,
        gatewayId,
        controlToken,
        createdAt: new Date().toISOString()
      });
      child = spawn(process.execPath, localGatewayChildArgs({ cliEntry, port: requestedPort, gatewayId }), {
        detached: true,
        stdio: ['ignore', handle.fd, handle.fd],
        windowsHide: true,
        env: process.env
      });
      if (!child.pid) throw new Error('Could not start local gateway process.');
      child.unref();
      await writeLocalGatewayState(environment, {
        version: 1,
        gatewayId,
        controlToken,
        port: requestedPort,
        pid: child.pid,
        agentVersion: version,
        startedAt: new Date().toISOString(),
        logPath
      });
    } finally {
      await handle.close();
    }

    const ready = await waitForGateway(environment, gatewayId);
    if (!ready) {
      try { child?.kill('SIGTERM'); } catch {}
      await removeLocalGatewayState(environment);
      throw new Error(`Local gateway did not become ready on port ${requestedPort}. Check ${logPath}.`);
    }
    await removeLocalGatewayStartup(environment).catch(() => undefined);
    await writeLocalGatewayConfig(environment, { port: requestedPort });
    return { ...ready, alreadyRunning: false };
  } finally {
    await removeLocalGatewayStartup(environment).catch(() => undefined);
    await releaseLock().catch(() => undefined);
  }
}

export async function stopLocalGateway(environment) {
  const status = await getLocalGatewayStatus(environment);
  if (!status.running) {
    if (status.state) await removeLocalGatewayState(environment);
    return { stopped: false, alreadyStopped: true, state: status.state };
  }

  const response = await fetch(`http://127.0.0.1:${status.state.port}/_bdxa/shutdown`, {
    method: 'POST',
    headers: { 'x-bdxa-control-token': status.state.controlToken, accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Local gateway refused shutdown (${response.status}).`);

  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (!(await getLocalGatewayStatus(environment)).running) break;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if ((await getLocalGatewayStatus(environment)).running) throw new Error('Local gateway did not stop in time.');
  await removeLocalGatewayState(environment);
  return { stopped: true, alreadyStopped: false, state: status.state };
}
