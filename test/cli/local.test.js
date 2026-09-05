import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import test from 'node:test';
import { getMcpToolDefinitions } from '../../src/transport/mcp/tools/registry.js';
import { instancePolicyPath } from '../../src/permissions/store.js';
import { requestInstanceControl } from '../../src/utils/instance-control.js';
import { terminateRecoveredProcess } from '../../src/utils/instances.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = path.join(repoRoot, 'src', 'cli.js');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function setupFixture() {
  const base = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
  const home = await mkdtemp(path.join(base, 'bdxa-local-home-'));
  const buildifyxHome = path.join(home, '.buildifyx');
  const workspaceA = await mkdtemp(path.join(base, 'bdxa-local-a-'));
  const workspaceB = await mkdtemp(path.join(base, 'bdxa-local-b-'));
  await mkdir(buildifyxHome, { recursive: true });
  await writeFile(path.join(workspaceA, 'which.txt'), 'workspace-a\n');
  await writeFile(path.join(workspaceB, 'which.txt'), 'workspace-b\n');
  return { home, buildifyxHome, workspaceA, workspaceB, extraEnv: {} };
}

function spawnCli(args, fixture) {
  return spawn(process.execPath, [cliPath, ...args], {
    cwd: fixture.workspaceA,
    env: {
      ...process.env,
      HOME: fixture.home,
      USERPROFILE: fixture.home,
      APPDATA: path.join(fixture.home, 'AppData', 'Roaming'),
      BUILDFYX_HOME: fixture.buildifyxHome,
      BUILDFYX_SKIP_UPDATE_CHECK: '1',
      ...fixture.extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

async function runCli(args, fixture) {
  const child = spawnCli(args, fixture);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  return { code, stdout, stderr };
}

async function waitForChildExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => child.once('exit', resolve));
}

async function waitFor(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Timed out waiting for local lifecycle condition.');
}

async function localRecords(fixture) {
  const directory = path.join(fixture.buildifyxHome, 'local', 'instances');
  try {
    const names = (await readdir(directory)).filter((name) => name.endsWith('.json'));
    return Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function cleanupFixture(fixture) {
  await runCli(['local', 'down'], fixture).catch(() => undefined);
  await rm(fixture.home, { recursive: true, force: true });
  await rm(fixture.workspaceA, { recursive: true, force: true });
  await rm(fixture.workspaceB, { recursive: true, force: true });
}

test('local gateway and instance lifecycle stay isolated from Cloud state', async () => {
  const fixture = await setupFixture();
  const port = await freePort();
  try {
    const up = await runCli(['local', 'up', String(port)], fixture);
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, new RegExp(`127\\.0\\.0\\.1:${port}/mcp`));

    const first = await runCli(['local', '-d', '--root', fixture.workspaceA, '--name', 'local-a'], fixture);
    const second = await runCli(['local', '-d', '--root', fixture.workspaceB, '--name', 'local-b'], fixture);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);

    await waitFor(async () => {
      const records = await localRecords(fixture);
      return records.length === 2 && records.every((item) => item.pid > 0 && item.status === 'connected');
    });

    assert.equal(await readFile(path.join(fixture.buildifyxHome, 'local', 'gateway-config.json'), 'utf8').then((value) => JSON.parse(value).port), port);
    await assert.rejects(readFile(path.join(fixture.buildifyxHome, 'credentials.json'), 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readdir(path.join(fixture.buildifyxHome, 'instances')), { code: 'ENOENT' });

    const idsBefore = (await localRecords(fixture)).map((item) => item.instanceId).sort();
    const restarted = await runCli(['local', 'restart', '--all'], fixture);
    assert.equal(restarted.code, 0, restarted.stderr);
    await waitFor(async () => (await localRecords(fixture)).every((item) => item.status === 'connected'));
    assert.deepEqual((await localRecords(fixture)).map((item) => item.instanceId).sort(), idsBefore);

    const down = await runCli(['local', 'down'], fixture);
    assert.equal(down.code, 0, down.stderr);
    const status = await runCli(['local', 'status'], fixture);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /Status\s+stopped/);
    const stopped = await localRecords(fixture);
    assert.equal(stopped.length, 2);
    assert.equal(stopped.every((item) => item.status === 'stopped' && item.pid === 0), true);

    assert.equal((await runCli(['local', 'up', String(port)], fixture)).code, 0);
    assert.equal((await runCli(['local', 'start', 'local-a'], fixture)).code, 0);
    await waitFor(async () => (await localRecords(fixture)).some((item) => item.name === 'local-a' && item.status === 'connected'));
    const restartedA = (await localRecords(fixture)).find((item) => item.name === 'local-a');
    assert.equal(restartedA.instanceId, idsBefore.find((id) => stopped.some((item) => item.instanceId === id && item.name === 'local-a')));
  } finally {
    await cleanupFixture(fixture);
  }
});

async function initializeMcp(port) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'local-test', version: '1' } }
    })
  });
  assert.equal(response.status, 200);
  const sessionId = response.headers.get('mcp-session-id');
  assert.ok(sessionId);
  await response.json();
  return sessionId;
}

async function mcpCall(port, sessionId, id, method, params) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('one local MCP port routes shared tools to multiple local instances', async () => {
  const fixture = await setupFixture();
  const port = await freePort();
  try {
    assert.equal((await runCli(['local', 'up', String(port)], fixture)).code, 0);
    assert.equal((await runCli(['local', '-d', '--root', fixture.workspaceA, '--name', 'local-a'], fixture)).code, 0);
    assert.equal((await runCli(['local', '-d', '--root', fixture.workspaceB, '--name', 'local-b'], fixture)).code, 0);
    await waitFor(async () => (await localRecords(fixture)).filter((item) => item.status === 'connected').length === 2);

    const sessionId = await initializeMcp(port);
    const tools = await mcpCall(port, sessionId, 2, 'tools/list', {});
    const names = tools.result.tools.map((item) => item.name).sort();
    const expected = ['list_workspaces', 'use_workspace', ...getMcpToolDefinitions().map((item) => item.name)].sort();
    assert.deepEqual(names, expected);

    const listed = await mcpCall(port, sessionId, 3, 'tools/call', { name: 'list_workspaces', arguments: {} });
    assert.equal(listed.result.structuredContent.workspaces.length, 2);
    assert.equal(listed.result.structuredContent.devices.length, 1);

    const readA = await mcpCall(port, sessionId, 4, 'tools/call', {
      name: 'read_file', arguments: { workspace: 'local-a', path: 'which.txt' }
    });
    assert.equal(readA.result.structuredContent.content, 'workspace-a\n');

    const selected = await mcpCall(port, sessionId, 5, 'tools/call', {
      name: 'use_workspace', arguments: { workspace: 'local-b' }
    });
    assert.equal(selected.result.structuredContent.selected.name, 'local-b');
    const readSelected = await mcpCall(port, sessionId, 6, 'tools/call', {
      name: 'read_file', arguments: { path: 'which.txt' }
    });
    assert.equal(readSelected.result.structuredContent.content, 'workspace-b\n');
  } finally {
    await cleanupFixture(fixture);
  }
});

async function installAutostartStub(fixture) {
  const bin = path.join(fixture.home, 'bin');
  await mkdir(bin, { recursive: true });
  if (process.platform === 'darwin') {
    const command = path.join(bin, 'launchctl');
    await writeFile(command, '#!/bin/sh\nexit 0\n');
    await chmod(command, 0o755);
  } else if (process.platform === 'linux') {
    const command = path.join(bin, 'systemctl');
    await writeFile(command, '#!/bin/sh\nexit 0\n');
    await chmod(command, 0o755);
  }
  fixture.extraEnv.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
}

test('local autostart restore brings up the saved gateway port before local instances', async (t) => {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) {
    t.skip(`Autostart is not supported on ${process.platform}.`);
    return;
  }
  const fixture = await setupFixture();
  const port = await freePort();
  await installAutostartStub(fixture);
  try {
    assert.equal((await runCli(['local', 'up', String(port)], fixture)).code, 0);
    assert.equal((await runCli(['local', '-d', '--root', fixture.workspaceA, '--name', 'auto-local'], fixture)).code, 0);
    await waitFor(async () => (await localRecords(fixture)).some((item) => item.name === 'auto-local' && item.status === 'connected'));

    const enabled = await runCli(['local', 'autostart', 'auto-local'], fixture);
    assert.equal(enabled.code, 0, enabled.stderr);
    const profile = JSON.parse(await readFile(path.join(fixture.buildifyxHome, 'local', 'autostart.json'), 'utf8'));
    assert.equal(profile.instances.length, 1);

    assert.equal((await runCli(['local', 'down'], fixture)).code, 0);
    const restored = await runCli(['__autostart-restore', 'local'], fixture);
    assert.equal(restored.code, 0, restored.stderr);

    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (!response.ok) return false;
        const body = await response.json();
        const records = await localRecords(fixture);
        return body.ok && records.some((item) => item.name === 'auto-local' && item.pid > 0 && item.status === 'connected');
      } catch {
        return false;
      }
    }, 8000);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('local down removes foreground registry/name but preserves its policy file', async () => {
  const fixture = await setupFixture();
  const port = await freePort();
  let foreground = null;
  let reopened = null;
  try {
    assert.equal((await runCli(['local', 'up', String(port)], fixture)).code, 0);
    foreground = spawnCli(['local', '--no-tui', '--root', fixture.workspaceA, '--name', 'foreground-down'], fixture);
    let foregroundError = '';
    foreground.stderr.on('data', (chunk) => { foregroundError += chunk.toString(); });
    await waitFor(async () => (await localRecords(fixture)).some((item) => item.name === 'foreground-down' && item.status === 'connected'));
    const record = (await localRecords(fixture)).find((item) => item.name === 'foreground-down');
    const policyPath = instancePolicyPath(record.instanceId, path.join(fixture.buildifyxHome, 'local'));
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(policyPath, JSON.stringify({ categories: { read: 'allow' }, additionalRoots: [], commandRules: [] }));

    const down = await runCli(['local', 'down'], fixture);
    assert.equal(down.code, 0, down.stderr);
    await waitForChildExit(foreground);
    assert.equal(foregroundError, '');
    assert.equal((await localRecords(fixture)).some((item) => item.name === 'foreground-down'), false);
    await readFile(policyPath, 'utf8');

    assert.equal((await runCli(['local', 'up', String(port)], fixture)).code, 0);
    reopened = spawnCli(['local', '--no-tui', '--root', fixture.workspaceA, '--name', 'foreground-down'], fixture);
    let reopenError = '';
    reopened.stderr.on('data', (chunk) => { reopenError += chunk.toString(); });
    await waitFor(async () => (await localRecords(fixture)).some((item) => item.name === 'foreground-down' && item.status === 'connected'));
    assert.equal(reopenError, '');
  } finally {
    await runCli(['local', 'down'], fixture).catch(() => undefined);
    if (foreground && foreground.exitCode === null && foreground.signalCode === null) foreground.kill('SIGKILL');
    if (reopened && reopened.exitCode === null && reopened.signalCode === null) reopened.kill('SIGKILL');
    await cleanupFixture(fixture);
  }
});





test('Cloud recovered-process cleanup cannot terminate a Local instance', async (t) => {
  if (process.platform === 'win32') return t.skip('process discovery is not available on Windows');
  const fixture = await setupFixture();
  const port = await freePort();
  try {
    assert.equal((await runCli(['local', 'up', String(port)], fixture)).code, 0);
    assert.equal((await runCli(['local', '-d', '--root', fixture.workspaceA, '--name', 'local-isolation'], fixture)).code, 0);
    await waitFor(async () => (await localRecords(fixture)).some((item) => item.name === 'local-isolation' && item.status === 'connected'));
    const record = (await localRecords(fixture)).find((item) => item.name === 'local-isolation');
    assert.ok(record?.pid > 0);
    const command = execFileSync('ps', ['-p', String(record.pid), '-o', 'args='], { encoding: 'utf8' }).trim();
    const recovered = {
      ...record,
      processOnly: true,
      processCommand: command,
      processCwd: fixture.workspaceA,
      live: true,
      pidAlive: true
    };
    await assert.rejects(
      () => terminateRecoveredProcess(recovered, { transport: 'cloud' }),
      /identity changed/i
    );
    assert.doesNotThrow(() => process.kill(record.pid, 0));
    const after = (await localRecords(fixture)).find((item) => item.instanceId === record.instanceId);
    assert.equal(after?.pid, record.pid);
  } finally {
    await cleanupFixture(fixture);
  }
});
test('concurrent local up converges on one gateway and health stays lightweight', async () => {
  const fixture = await setupFixture();
  const port = await freePort();
  try {
    const localRoot = path.join(fixture.buildifyxHome, 'local');
    await mkdir(localRoot, { recursive: true });
    await writeFile(path.join(localRoot, 'gateway.lock'), JSON.stringify({ lockId: 'stale', pid: 0, createdAt: '2000-01-01T00:00:00.000Z' }));
    const [first, second] = await Promise.all([
      runCli(['local', 'up', String(port)], fixture),
      runCli(['local', 'up', String(port)], fixture)
    ]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    const combined = `${first.stdout}
${second.stdout}`;
    assert.match(combined, /Local gateway (?:is already running|started)/);

    const state = JSON.parse(await readFile(path.join(fixture.buildifyxHome, 'local', 'gateway.json'), 'utf8'));
    assert.equal(state.port, port);
    assert.ok(Number.isInteger(state.pid) && state.pid > 0);
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.gatewayId, state.gatewayId);
    assert.equal(Object.prototype.hasOwnProperty.call(health, 'instances'), false);
    await assert.rejects(readFile(path.join(fixture.buildifyxHome, 'local', 'gateway.lock'), 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(fixture.buildifyxHome, 'local', 'gateway-startup.json'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await cleanupFixture(fixture);
  }
});
test('local MCP uses No Auth while internal gateway shutdown stays protected', async () => {
  const fixture = await setupFixture();
  const port = await freePort();
  try {
    const up = await runCli(['local', 'up', String(port)], fixture);
    assert.equal(up.code, 0, up.stderr);
    assert.match(up.stdout, /Auth\s+No Auth/);
    await assert.rejects(readFile(path.join(fixture.buildifyxHome, 'local', 'auth.json'), 'utf8'), { code: 'ENOENT' });

    const sessionId = await initializeMcp(port);
    assert.ok(sessionId);

    const status = await runCli(['local', 'status'], fixture);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /Auth\s+No Auth/);

    const removedTokenCommand = await runCli(['local', 'token'], fixture);
    assert.equal(removedTokenCommand.code, 1);
    assert.match(removedTokenCommand.stderr, /Unknown local command: token/);

    const denied = await fetch(`http://127.0.0.1:${port}/_bdxa/shutdown`, { method: 'POST' });
    assert.equal(denied.status, 403);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
  } finally {
    await cleanupFixture(fixture);
  }
});

test('local MCP cancellation stops an active runtime command', async () => {
  const fixture = await setupFixture();
  const port = await freePort();
  try {
    assert.equal((await runCli(['local', 'up', String(port)], fixture)).code, 0);
    assert.equal((await runCli(['local', '-d', '--unrestricted-commands', '--root', fixture.workspaceA, '--name', 'cancel-local'], fixture)).code, 0);
    await waitFor(async () => (await localRecords(fixture)).some((item) => item.name === 'cancel-local' && item.status === 'connected'));

    const sessionId = await initializeMcp(port);
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId
    };
    const controller = new AbortController();
    const call = fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 10, method: 'tools/call',
        params: {
          name: 'run_command',
          arguments: { workspace: 'cancel-local', command: 'node', args: ['-e', 'setTimeout(()=>{},10000)'], timeoutMs: 15000 }
        }
      })
    }).catch(() => null);

    await new Promise((resolve) => setTimeout(resolve, 400));
    const cancelled = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 10, reason: 'test cancellation' } })
    });
    assert.equal(cancelled.status, 202);

    const record = (await localRecords(fixture)).find((item) => item.name === 'cancel-local');
    await waitFor(async () => {
      const snapshot = await requestInstanceControl(record, 'dashboard.snapshot', { timeoutMs: 1500 });
      return snapshot.dashboard.events.some((event) => event.type === 'tool.failed' && event.tool === 'run_command' && event.error?.code === 'REQUEST_CANCELLED');
    }, 5000);
    controller.abort();
    await call;
  } finally {
    await cleanupFixture(fixture);
  }
});
