import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { instancePolicyPath } from '../../src/permissions/store.js';
import { instanceControlPath, requestInstanceControl } from '../../src/utils/instance-control.js';

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

test('rm --all stops a live agent and resets its instance policy', async () => {
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


test('rm -f force-stops a live agent within the CLI timeout and cleans its settings', async () => {
  const fixture = await setupFixture();
  const agent = spawnCli(['--no-tui', '--root', fixture.workspace, '--name', 'rm-force-test'], fixture);
  const agentOutput = collect(agent);
  try {
    await waitFor(async () => {
      if (agent.exitCode !== null || agent.signalCode !== null) throw new Error(`Agent exited before registry ready: ${agentOutput().stderr || agentOutput().stdout}`);
      return (await instanceJsonFiles(fixture)).length === 1;
    });
    await waitFor(() => agentOutput().stdout.includes('Buildifyx Desktop Agent'));

    const agentExit = once(agent, 'exit');
    const startedAt = Date.now();
    const remover = spawnCli(['rm', '-f', 'rm-force-test'], fixture);
    const removerOutput = collect(remover);
    const [removeCode] = await once(remover, 'exit');
    const elapsed = Date.now() - startedAt;
    assert.equal(removeCode, 0, removerOutput().stderr);
    assert.ok(elapsed < 1500, `rm -f took ${elapsed} ms`);

    const [agentCode, agentSignal] = await agentExit;
    assert.equal(agentSignal, null);
    assert.equal(agentCode, 1, agentOutput().stderr);
    await waitFor(async () => (await instanceJsonFiles(fixture)).length === 0);
    assert.deepEqual(await readdir(path.join(fixture.buildifyxHome, 'instance-settings')), []);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(await instanceJsonFiles(fixture), []);
  } finally {
    if (agent.exitCode === null && agent.signalCode === null) agent.kill('SIGKILL');
    await cleanupFixture(fixture);
  }
});

test('restart keeps the same instance identity and policy while replacing the background process', async () => {
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
    const packageVersion = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')).version;
    await writeFile(recordPath, `${JSON.stringify({ ...before, agentVersion: '0.0.0-test' }, null, 2)}\n`);

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
    assert.equal(after.agentVersion, packageVersion);
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
test('restart failure preserves the instance record, log path, and policy for recovery', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 500));
    const stable = JSON.parse(await readFile(recordPath, 'utf8'));
    assert.equal(stable.status, 'restart_failed');
    assert.equal(stable.logPath, before.logPath);
  } finally {
    if (cleanupNeeded) {
      const remover = spawnCli(['rm', '--all'], fixture);
      await once(remover, 'exit').catch(() => undefined);
    }
    await cleanupFixture(fixture);
  }
});

test('restart child control failure preserves the existing instance policy', async () => {
  const fixture = await setupFixture();
  let blocker = null;
  try {
    const instanceId = 'inst_restart_control_failure';
    const name = 'restart-control-failure-test';
    const instancesDir = path.join(fixture.buildifyxHome, 'instances');
    const recordPath = path.join(instancesDir, `${instanceId}.json`);
    const logPath = path.join(instancesDir, `${instanceId}.log`);
    await mkdir(instancesDir, { recursive: true });
    await writeFile(logPath, 'restart control failure test\n');
    await writeFile(recordPath, `${JSON.stringify({
      instanceId,
      name,
      workspace: fixture.workspace,
      mode: 'background',
      pid: 0,
      status: 'starting',
      startedAt: new Date().toISOString(),
      agentVersion: '0.2.0',
      deviceName: 'lifecycle-test-device',
      logPath
    }, null, 2)}\n`);

    const policyPath = instancePolicyPath(instanceId, fixture.buildifyxHome);
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(policyPath, `${JSON.stringify({ categories: { read: 'deny' }, additionalRoots: [], commandRules: [] }, null, 2)}\n`);

    const controlBlocker = instanceControlPath(instanceId, instancesDir);
    if (process.platform === 'win32') {
      blocker = net.createServer();
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        blocker.once('error', onError);
        blocker.listen(controlBlocker, () => {
          blocker.off('error', onError);
          resolve();
        });
      });
    } else {
      await mkdir(controlBlocker);
    }

    const child = spawnCli([
      '--root', fixture.workspace,
      '--instance-id', instanceId,
      '--instance-name', name,
      '--background-child',
      '--restart-child'
    ], fixture);
    const output = collect(child);
    const [code] = await once(child, 'exit');
    assert.equal(code, 1, output().stdout);

    const after = JSON.parse(await readFile(recordPath, 'utf8'));
    assert.equal(after.instanceId, instanceId);
    assert.equal(after.status, 'restart_child_failed');
    assert.equal(after.logPath, logPath);
    assert.equal(JSON.parse(await readFile(policyPath, 'utf8')).categories.read, 'deny');
  } finally {
    if (blocker) await new Promise((resolve) => blocker.close(() => resolve()));
    await cleanupFixture(fixture);
  }
});

test('local workspace requires the local gateway before starting', async () => {
  const fixture = await setupFixture();
  try {
    const child = spawnCli(['local'], fixture);
    const output = collect(child);
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.match(output().stderr, /Local gateway is not running/);
    assert.match(output().stderr, /bdxa local up/);
    assert.doesNotMatch(output().stderr, /sign in|login/i);
  } finally {
    await cleanupFixture(fixture);
  }
});

async function installAutostartCommandStub(fixture) {
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
  return bin;
}

test('background stop/restart and per-instance autostart follow Docker-style lifecycle semantics', async () => {
  const fixture = await setupFixture();
  const autostartPath = path.join(fixture.buildifyxHome, 'autostart.json');
  const stubBin = await installAutostartCommandStub(fixture);
  const toolPath = `${stubBin}${path.delimiter}${process.env.PATH ?? ''}`;
  let cleanupNeeded = false;

  try {
    const starter = spawnCli(['-d', '--root', fixture.workspace, '--name', 'lifecycle-v3-test'], fixture);
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
    const initial = JSON.parse(await readFile(recordPath, 'utf8'));
    await assert.rejects(readFile(autostartPath, 'utf8'), (error) => error?.code === 'ENOENT');

    const policyUpdate = await requestInstanceControl(initial, 'policy.setCategory', {
      timeoutMs: 1500,
      payload: { category: 'read', action: 'deny' }
    });
    assert.equal(policyUpdate.ok, true);
    const policyPath = instancePolicyPath(initial.instanceId, fixture.buildifyxHome);

    const enable = spawnCli(['autostart', 'lifecycle-v3-test'], fixture, { PATH: toolPath });
    const enableOutput = collect(enable);
    const [enableCode] = await once(enable, 'exit');
    assert.equal(enableCode, 0, enableOutput().stderr);
    let autostart = JSON.parse(await readFile(autostartPath, 'utf8'));
    assert.deepEqual(autostart.instances.map((item) => item.instanceId), [initial.instanceId]);

    const stop = spawnCli(['stop', 'lifecycle-v3-test'], fixture);
    const stopOutput = collect(stop);
    const [stopCode] = await once(stop, 'exit');
    assert.equal(stopCode, 0, stopOutput().stderr);
    await waitFor(async () => JSON.parse(await readFile(recordPath, 'utf8')).status === 'stopped');
    const stopped = JSON.parse(await readFile(recordPath, 'utf8'));
    const startAgain = spawnCli(['start', 'lifecycle-v3-test'], fixture);
    const startAgainOutput = collect(startAgain);
    const [startAgainCode] = await once(startAgain, 'exit');
    assert.equal(startAgainCode, 0, startAgainOutput().stderr);
    await waitFor(async () => {
      const current = JSON.parse(await readFile(recordPath, 'utf8'));
      return current.pid > 0 && current.status !== 'stopped';
    });
    const restarted = JSON.parse(await readFile(recordPath, 'utf8'));
    assert.equal(restarted.instanceId, initial.instanceId);
    assert.equal(JSON.parse(await readFile(policyPath, 'utf8')).categories.read, 'deny');

    const stopAgain = spawnCli(['stop', 'lifecycle-v3-test'], fixture);
    const stopAgainOutput = collect(stopAgain);
    const [stopAgainCode] = await once(stopAgain, 'exit');
    assert.equal(stopAgainCode, 0, stopAgainOutput().stderr);
    await waitFor(async () => JSON.parse(await readFile(recordPath, 'utf8')).status === 'stopped');

    const disable = spawnCli(['autostart', 'off', 'lifecycle-v3-test'], fixture, { PATH: toolPath });
    const disableOutput = collect(disable);
    const [disableCode] = await once(disable, 'exit');
    assert.equal(disableCode, 0, disableOutput().stderr);
    autostart = JSON.parse(await readFile(autostartPath, 'utf8'));
    assert.deepEqual(autostart.instances, []);
    assert.equal(JSON.parse(await readFile(recordPath, 'utf8')).status, 'stopped');

    const restart = spawnCli(['restart', 'lifecycle-v3-test'], fixture);
    const restartOutput = collect(restart);
    const [restartCode] = await once(restart, 'exit');
    assert.equal(restartCode, 0, restartOutput().stderr);
    await waitFor(async () => {
      const current = JSON.parse(await readFile(recordPath, 'utf8'));
      return current.pid > 0 && current.status !== 'stopped' && current.instanceId === initial.instanceId;
    });

    const stopAfterRestart = spawnCli(['stop', 'lifecycle-v3-test'], fixture);
    const stopAfterRestartOutput = collect(stopAfterRestart);
    const [stopAfterRestartCode] = await once(stopAfterRestart, 'exit');
    assert.equal(stopAfterRestartCode, 0, stopAfterRestartOutput().stderr);
    await waitFor(async () => JSON.parse(await readFile(recordPath, 'utf8')).status === 'stopped');

    const enableStopped = spawnCli(['autostart', 'lifecycle-v3-test'], fixture, { PATH: toolPath });
    const enableStoppedOutput = collect(enableStopped);
    const [enableStoppedCode] = await once(enableStopped, 'exit');
    assert.equal(enableStoppedCode, 0, enableStoppedOutput().stderr);
    autostart = JSON.parse(await readFile(autostartPath, 'utf8'));
    assert.deepEqual(autostart.instances.map((item) => item.instanceId), [initial.instanceId]);

    const secondStarter = spawnCli(['-d', '--root', fixture.workspace, '--name', 'lifecycle-v3-other'], fixture);
    const secondStarterOutput = collect(secondStarter);
    const [secondStartCode] = await once(secondStarter, 'exit');
    assert.equal(secondStartCode, 0, secondStarterOutput().stderr);
    await waitFor(async () => (await instanceJsonFiles(fixture)).length === 2);
    const records = await Promise.all((await instanceJsonFiles(fixture)).map(async (name) =>
      JSON.parse(await readFile(path.join(fixture.buildifyxHome, 'instances', name), 'utf8'))
    ));
    const secondRecord = records.find((item) => item.name === 'lifecycle-v3-other');
    assert.ok(secondRecord);

    const enableSecond = spawnCli(['autostart', 'lifecycle-v3-other'], fixture, { PATH: toolPath });
    const enableSecondOutput = collect(enableSecond);
    const [enableSecondCode] = await once(enableSecond, 'exit');
    assert.equal(enableSecondCode, 0, enableSecondOutput().stderr);
    autostart = JSON.parse(await readFile(autostartPath, 'utf8'));
    assert.deepEqual(autostart.instances.map((item) => item.instanceId).sort(), [initial.instanceId, secondRecord.instanceId].sort());

    const remover = spawnCli(['rm', 'lifecycle-v3-test'], fixture, { PATH: toolPath });
    const removerOutput = collect(remover);
    const [removeCode] = await once(remover, 'exit');
    assert.equal(removeCode, 0, removerOutput().stderr);
    assert.equal((await instanceJsonFiles(fixture)).length, 1);
    autostart = JSON.parse(await readFile(autostartPath, 'utf8'));
    assert.deepEqual(autostart.instances.map((item) => item.instanceId), [secondRecord.instanceId]);

    const removeSecond = spawnCli(['rm', 'lifecycle-v3-other'], fixture, { PATH: toolPath });
    const removeSecondOutput = collect(removeSecond);
    const [removeSecondCode] = await once(removeSecond, 'exit');
    assert.equal(removeSecondCode, 0, removeSecondOutput().stderr);
    cleanupNeeded = false;
    assert.deepEqual(await instanceJsonFiles(fixture), []);
    autostart = JSON.parse(await readFile(autostartPath, 'utf8'));
    assert.deepEqual(autostart.instances, []);
  } finally {
    if (cleanupNeeded) {
      const remover = spawnCli(['rm', '--all'], fixture, { PATH: toolPath });
      await once(remover, 'exit').catch(() => undefined);
    }
    await cleanupFixture(fixture);
  }
});