import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { requestInstanceControl } from '../../src/utils/instance-control.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = path.join(repoRoot, 'src', 'cli.js');

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for lifecycle condition.');
}

async function setupFixture() {
  const tempRoot = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
  const home = await mkdtemp(path.join(tempRoot, 'bdxh-'));
  const workspace = await mkdtemp(path.join(tempRoot, 'bdxw-'));
  const buildifyxHome = path.join(home, '.buildifyx');
  await mkdir(buildifyxHome, { recursive: true });
  await writeFile(path.join(buildifyxHome, 'credentials.json'), `${JSON.stringify({
    cloudUrl: 'http://127.0.0.1:9',
    deviceId: 'dev_lifecycle_test',
    deviceName: 'lifecycle-test-device',
    deviceToken: 'bdx_device_lifecycle_test',
    expiresAt: null,
    createdAt: new Date().toISOString()
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { home, workspace, buildifyxHome };
}

function spawnCli(args, fixture, extraEnv = {}) {
  return spawn(process.execPath, [cliPath, ...args], {
    cwd: fixture.workspace,
    env: {
      ...process.env,
      HOME: fixture.home,
      USERPROFILE: fixture.home,
      BUILDFYX_SKIP_UPDATE_CHECK: '1',
      BUILDFYX_HOME: fixture.buildifyxHome,
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

function collect(child) {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  return () => ({ stdout, stderr });
}

async function instanceJsonFiles(fixture) {
  try {
    return (await readdir(path.join(fixture.buildifyxHome, 'instances'))).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function cleanupFixture(fixture) {
  await rm(fixture.home, { recursive: true, force: true });
  await rm(fixture.workspace, { recursive: true, force: true });
}

test('foreground agent exits cleanly on SIGINT and removes its registry record', { skip: process.platform === 'win32' }, async () => {
  const fixture = await setupFixture();
  const child = spawnCli(['--no-tui', '--root', fixture.workspace, '--name', 'sigint-test'], fixture);
  const output = collect(child);
  try {
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Agent exited before registry ready: ${output().stderr || output().stdout}`);
      return (await instanceJsonFiles(fixture)).length === 1;
    });
    await waitFor(() => output().stdout.includes('Buildifyx Desktop Agent'));
    const childExit = once(child, 'exit');
    child.kill('SIGINT');
    const [code, signal] = await childExit;
    assert.equal(signal, null);
    assert.equal(code, 0, output().stderr);
    await waitFor(async () => (await instanceJsonFiles(fixture)).length === 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await cleanupFixture(fixture);
  }
});

test('rm --all stops a live agent and resets its instance policy', { skip: process.platform === 'win32' }, async () => {
  const fixture = await setupFixture();
  const agent = spawnCli(['--no-tui', '--root', fixture.workspace, '--name', 'rm-all-test'], fixture);
  const agentOutput = collect(agent);
  try {
    await waitFor(async () => {
      if (agent.exitCode !== null || agent.signalCode !== null) throw new Error(`Agent exited before registry ready: ${agentOutput().stderr || agentOutput().stdout}`);
      return (await instanceJsonFiles(fixture)).length === 1;
    });
    await waitFor(() => agentOutput().stdout.includes('Buildifyx Desktop Agent'));
    await waitFor(async () => {
      try {
        return (await readdir(path.join(fixture.buildifyxHome, 'instance-settings'))).length > 0;
      } catch {
        return false;
      }
    });

    const agentExit = once(agent, 'exit');
    const remover = spawnCli(['rm', '--all'], fixture);
    const removerOutput = collect(remover);
    const [removeCode] = await once(remover, 'exit');
    assert.equal(removeCode, 0, removerOutput().stderr);

    const [agentCode, agentSignal] = await agentExit;
    assert.equal(agentSignal, null);
    assert.equal(agentCode, 0, agentOutput().stderr);
    await waitFor(async () => (await instanceJsonFiles(fixture)).length === 0);
    assert.deepEqual(await readdir(path.join(fixture.buildifyxHome, 'instance-settings')), []);
  } finally {
    if (agent.exitCode === null && agent.signalCode === null) agent.kill('SIGKILL');
    await cleanupFixture(fixture);
  }
});


test('restart keeps the same instance identity and policy while replacing the background process', { skip: process.platform === 'win32' }, async () => {
  const fixture = await setupFixture();
  let cleanupNeeded = false;
  try {
    const starter = spawnCli(['-d', '--root', fixture.workspace, '--name', 'restart-test'], fixture);
    const starterOutput = collect(starter);
    const [startCode] = await once(starter, 'exit');
    assert.equal(startCode, 0, starterOutput().stderr);
    cleanupNeeded = true;

    await waitFor(async () => (await instanceJsonFiles(fixture)).length === 1);
    const [recordName] = await instanceJsonFiles(fixture);
    const recordPath = path.join(fixture.buildifyxHome, 'instances', recordName);
    await waitFor(async () => {
      try { return Boolean(JSON.parse(await readFile(recordPath, 'utf8')).controlPath); } catch { return false; }
    });
    const before = JSON.parse(await readFile(recordPath, 'utf8'));

    const policyUpdate = await requestInstanceControl(before, 'policy.setCategory', {
      timeoutMs: 1500,
      payload: { category: 'read', action: 'deny' }
    });
    assert.equal(policyUpdate.ok, true);
    assert.equal(policyUpdate.policy.categories.read, 'deny');

    const settingsRoot = path.join(fixture.buildifyxHome, 'instance-settings');
    await waitFor(async () => {
      try { return (await readdir(settingsRoot)).length === 1; } catch { return false; }
    });
    const [settingsId] = await readdir(settingsRoot);
    const policyPath = path.join(settingsRoot, settingsId, 'policy.json');
    await waitFor(async () => {
      try { return JSON.parse(await readFile(policyPath, 'utf8')).categories.read === 'deny'; } catch { return false; }
    });

    const restarter = spawnCli(['restart', 'restart-test'], fixture);
    const restartOutput = collect(restarter);
    const [restartCode] = await once(restarter, 'exit');
    assert.equal(restartCode, 0, restartOutput().stderr);
    assert.match(restartOutput().stdout, /Restarted restart-test/);

    await waitFor(async () => {
      const current = JSON.parse(await readFile(recordPath, 'utf8'));
      return current.pid !== before.pid && current.instanceId === before.instanceId;
    });
    const after = JSON.parse(await readFile(recordPath, 'utf8'));
    assert.equal(after.instanceId, before.instanceId);
    assert.notEqual(after.pid, before.pid);
    assert.equal(after.logPath, before.logPath);
    assert.equal(typeof after.logPath, 'string');
    await readFile(after.logPath, 'utf8');
    assert.equal(JSON.parse(await readFile(policyPath, 'utf8')).categories.read, 'deny');
  } finally {
    if (cleanupNeeded) {
      const remover = spawnCli(['rm', '--all'], fixture);
      await once(remover, 'exit').catch(() => undefined);
    }
    await cleanupFixture(fixture);
  }
});
test('restart failure preserves the instance record, log path, and policy for recovery', { skip: process.platform === 'win32' }, async () => {
  const fixture = await setupFixture();
  let cleanupNeeded = false;
  try {
    const starter = spawnCli(['-d', '--root', fixture.workspace, '--name', 'restart-failure-test'], fixture);
    const starterOutput = collect(starter);
    const [startCode] = await once(starter, 'exit');
    assert.equal(startCode, 0, starterOutput().stderr);
    cleanupNeeded = true;

    await waitFor(async () => (await instanceJsonFiles(fixture)).length === 1);
    const [recordName] = await instanceJsonFiles(fixture);
    const recordPath = path.join(fixture.buildifyxHome, 'instances', recordName);
    await waitFor(async () => {
      try { return Boolean(JSON.parse(await readFile(recordPath, 'utf8')).controlPath); } catch { return false; }
    });
    const before = JSON.parse(await readFile(recordPath, 'utf8'));
    const settingsRoot = path.join(fixture.buildifyxHome, 'instance-settings');
    await waitFor(async () => {
      try { return (await readdir(settingsRoot)).length === 1; } catch { return false; }
    });

    await rm(path.join(fixture.buildifyxHome, 'credentials.json'), { force: true });
    const restarter = spawnCli(['restart', 'restart-failure-test'], fixture, { BUILDFYX_RESTART_READY_TIMEOUT_MS: '1200' });
    const restartOutput = collect(restarter);
    const [restartCode] = await once(restarter, 'exit');
    assert.equal(restartCode, 1);
    assert.match(restartOutput().stderr, /record and policy were preserved/i);

    const after = JSON.parse(await readFile(recordPath, 'utf8'));
    assert.equal(after.instanceId, before.instanceId);
    assert.equal(after.status, 'restart_failed');
    assert.equal(after.logPath, before.logPath);
    assert.equal(typeof after.lastError, 'string');
    assert.equal((await readdir(settingsRoot)).length, 1);
    await readFile(after.logPath, 'utf8');
  } finally {
    if (cleanupNeeded) {
      const remover = spawnCli(['rm', '--all'], fixture);
      await once(remover, 'exit').catch(() => undefined);
    }
    await cleanupFixture(fixture);
  }
});

test('local command reports that legacy local MCP mode was removed', async () => {
  const fixture = await setupFixture();
  try {
    const child = spawnCli(['local'], fixture);
    const output = collect(child);
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.match(output().stderr, /Local MCP mode has been removed/);
    assert.doesNotMatch(output().stderr, /Unknown command/);
  } finally {
    await cleanupFixture(fixture);
  }
});