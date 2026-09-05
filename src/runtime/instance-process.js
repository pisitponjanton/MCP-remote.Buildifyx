import { spawn } from 'node:child_process';
import process from 'node:process';
import { openInstanceLog, releaseInstanceName, removeInstanceRecord, saveInstance, shortInstanceId, updateInstance } from '../utils/instances.js';

const HANDOFF_TIMEOUT_MS = 8000;

export function approvalForDashboard(request) {
  return {
    id: request.id,
    requestId: request.requestId,
    createdAt: request.createdAt,
    toolName: request.toolName,
    description: request.description,
    category: request.category,
    pathInfo: request.pathInfo ? { ...request.pathInfo } : null,
    evaluation: request.evaluation ? { ...request.evaluation } : null
  };
}

export function hasInFlightTools(events) {
  const active = new Set();
  for (const event of events) {
    if (!event.requestId) continue;
    if (event.type === 'tool.started') active.add(event.requestId);
    if (event.type === 'tool.completed' || event.type === 'tool.failed') active.delete(event.requestId);
  }
  return active.size > 0;
}

function waitForChildMessage(child, expectedType, instanceId, timeoutMs = HANDOFF_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
      callback();
    };
    const onMessage = (message) => {
      if (message?.type !== expectedType || message?.instanceId !== instanceId) return;
      finish(() => resolve(message));
    };
    const onExit = (code, signal) => finish(() => reject(new Error(`Background handoff child exited before ${expectedType} (${signal ?? code ?? 'unknown'}).`)));
    const onError = (error) => finish(() => reject(error));
    const timer = setTimeout(() => finish(() => reject(new Error(`Timed out waiting for background handoff (${expectedType}).`))), timeoutMs);
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

export async function prepareHandoffChild({ environment, root, name, instanceId, unrestrictedCommands }) {
  const script = process.argv[1];
  if (!script) throw new Error('Could not determine the bdxa CLI entrypoint for background handoff.');
  const { filePath: logPath, handle } = await openInstanceLog(instanceId, environment.instancesDirectory);
  const childArgs = [script, ...environment.commandPrefix, '--root', root, '--instance-id', instanceId, '--instance-name', name, '--background-child', '--handoff-child'];
  if (unrestrictedCommands) childArgs.push('--unrestricted-commands');
  let child;
  try {
    child = spawn(process.execPath, childArgs, { detached: true, stdio: ['ignore', handle.fd, handle.fd, 'ipc'], windowsHide: true, env: process.env });
    if (!child.pid) throw new Error('Could not start background handoff process.');
    await waitForChildMessage(child, 'handoff.ready', instanceId);
  } catch (error) {
    child?.kill();
    throw error;
  } finally {
    await handle.close();
  }
  return {
    child,
    logPath,
    async activate() {
      const active = waitForChildMessage(child, 'handoff.active', instanceId);
      child.send({ type: 'handoff.activate', instanceId });
      const message = await active;
      child.unref();
      return { pid: message.pid ?? child.pid, logPath };
    },
    cancel() {
      try { child.send({ type: 'handoff.cancel', instanceId }); } catch {}
      try { child.kill(); } catch {}
    }
  };
}

export async function waitForHandoffActivation(instanceId) {
  if (typeof process.send !== 'function') throw new Error('Background handoff child requires an IPC channel.');
  process.send({ type: 'handoff.ready', instanceId, pid: process.pid });
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      callback();
    };
    const onMessage = (message) => {
      if (message?.instanceId !== instanceId) return;
      if (message.type === 'handoff.activate') finish(resolve);
      else if (message.type === 'handoff.cancel') finish(() => reject(new Error('Background handoff was cancelled.')));
    };
    const onDisconnect = () => finish(() => reject(new Error('Background handoff parent disconnected before activation.')));
    const timer = setTimeout(() => finish(() => reject(new Error('Timed out waiting for foreground handoff activation.'))), 30_000);
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
  });
}

export function notifyHandoffActive(instanceId) {
  if (typeof process.send !== 'function') return;
  try { process.send({ type: 'handoff.active', instanceId, pid: process.pid }); } catch {}
  try { process.disconnect(); } catch {}
}

export async function startDetachedInstance({ environment, root, name, instanceId, unrestrictedCommands, metadata, deviceName }) {
  const script = process.argv[1];
  if (!script) throw new Error('Could not determine the bdxa CLI entrypoint for detached mode.');
  const { filePath: logPath, handle } = await openInstanceLog(instanceId, environment.instancesDirectory);
  const childArgs = [script, ...environment.commandPrefix, '--root', root, '--instance-id', instanceId, '--instance-name', name, '--background-child'];
  if (unrestrictedCommands) childArgs.push('--unrestricted-commands');
  await saveInstance({
    instanceId,
    name,
    workspace: root,
    mode: 'background',
    pid: 0,
    status: 'starting',
    startedAt: new Date().toISOString(),
    agentVersion: metadata.version,
    deviceName,
    unrestrictedCommands,
    logPath
  }, environment.instancesDirectory);
  let child;
  try {
    child = spawn(process.execPath, childArgs, { detached: true, stdio: ['ignore', handle.fd, handle.fd], windowsHide: true, env: process.env });
    if (!child.pid) throw new Error('Could not start detached bdxa process.');
    child.unref();
    await updateInstance(instanceId, { pid: child.pid }, environment.instancesDirectory);
  } catch (error) {
    await removeInstanceRecord(instanceId, environment.instancesDirectory);
    await releaseInstanceName(name, instanceId, environment.instancesDirectory).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  console.log(`✓ Started ${name}`);
  console.log(`  ID         ${shortInstanceId(instanceId)}`);
  console.log(`  Workspace  ${root}`);
  console.log(`  PID        ${child.pid}`);
  console.log(`  Log        ${logPath}`);
}
