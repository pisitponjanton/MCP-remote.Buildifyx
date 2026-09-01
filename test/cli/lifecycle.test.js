import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

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

function spawnCli(args, fixture) {
  return spawn(process.execPath, [cliPath, ...args], {
    cwd: fixture.workspace,
    env: {
      ...process.env,
      HOME: fixture.home,
      USERPROFILE: fixture.home,
      BUILDFYX_HOME: fixture.buildifyxHome
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
