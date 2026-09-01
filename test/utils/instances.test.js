import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startInstanceControl } from '../../src/utils/instance-control.js';
import {
  claimInstanceName,
  createInstanceId,
  findInstance,
  listInstances,
  loadInstance,
  parseBdxaAgentProcessCommand,
  releaseInstanceName,
  removeInstanceRecord,
  saveInstance,
  shortInstanceId
} from '../../src/utils/instances.js';

async function withTempDir(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bdxa-instance-test-'));
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('instance registry verifies a live bdxa process through its control socket', async () => {
  await withTempDir(async (directory) => {
    const instanceId = createInstanceId();
    const control = await startInstanceControl({ instanceId, directory });
    try {
      await saveInstance({
        instanceId,
        name: 'backend',
        workspace: '/tmp/backend',
        mode: 'foreground',
        pid: process.pid,
        status: 'connected',
        controlPath: control.endpoint,
        startedAt: new Date().toISOString()
      }, directory);

      const listed = await listInstances(directory);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].live, true);
      assert.equal(listed[0].verified, true);
      assert.equal((await findInstance(instanceId, directory)).instanceId, instanceId);
      assert.equal(shortInstanceId(instanceId).length, 8);

      await removeInstanceRecord(instanceId, directory);
      assert.equal((await listInstances(directory)).length, 0);
    } finally {
      await control.close();
    }
  });
});

test('a missing JSON record is recovered from an existing name lock and legacy dashboard control', async () => {
  await withTempDir(async (directory) => {
    const instanceId = createInstanceId();
    await claimInstanceName('/tmp/orphan-workspace', 'orphan-workspace', instanceId, directory);
    const control = await startInstanceControl({
      instanceId,
      directory,
      onCommand(message) {
        if (message.command !== 'dashboard.snapshot') return undefined;
        return {
          dashboard: {
            root: '/tmp/orphan-workspace',
            instanceName: 'orphan-workspace',
            runtimeMode: 'background',
            version: '0.2.0',
            connection: { status: 'connected' }
          }
        };
      }
    });

    try {
      assert.equal(await loadInstance(instanceId, directory), null);
      const listed = await listInstances(directory);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].instanceId, instanceId);
      assert.equal(listed[0].name, 'orphan-workspace');
      assert.equal(listed[0].workspace, '/tmp/orphan-workspace');
      assert.equal(listed[0].live, true);
      assert.equal((await loadInstance(instanceId, directory)).pid, process.pid);
    } finally {
      await control.close();
      await releaseInstanceName('orphan-workspace', instanceId, directory);
      await removeInstanceRecord(instanceId, directory);
    }
  });
});

test('recent audit identity recovers a pre-discovery orphan with no JSON record or name lock', async () => {
  const baseDirectory = await mkdtemp('/tmp/bdxa-audit-');
  const directory = path.join(baseDirectory, 'instances');
  await mkdir(directory, { recursive: true });
  const instanceId = createInstanceId();
  const control = await startInstanceControl({
    instanceId,
    directory,
    onCommand(message) {
      if (message.command !== 'dashboard.snapshot') return undefined;
      return {
        dashboard: {
          root: '/tmp/audit-orphan',
          instanceName: 'audit-orphan',
          runtimeMode: 'background',
          version: '0.2.0',
          connection: { status: 'connected' }
        }
      };
    }
  });

  try {
    await writeFile(path.join(baseDirectory, 'audit.log'), `${JSON.stringify({
      type: 'tool.completed',
      instance: {
        instanceId,
        workspaceName: 'audit-orphan',
        workspacePath: '/tmp/audit-orphan'
      }
    })}\n`, 'utf8');

    const listed = await listInstances(directory);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].instanceId, instanceId);
    assert.equal(listed[0].name, 'audit-orphan');
    assert.equal(listed[0].workspace, '/tmp/audit-orphan');
    assert.equal(listed[0].verified, true);
  } finally {
    await control.close();
    await removeInstanceRecord(instanceId, directory);
    await rm(baseDirectory, { recursive: true, force: true });
  }
});
test('new control discovery recovers an orphan even when both JSON record and name lock are missing', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows named pipes are not enumerable from the instance directory; name locks provide recovery there.');
    return;
  }

  await withTempDir(async (directory) => {
    const instanceId = createInstanceId();
    const control = await startInstanceControl({
      instanceId,
      directory,
      metadata: {
        name: 'socket-only',
        workspace: '/tmp/socket-only',
        mode: 'background',
        agentVersion: '0.2.0',
        startedAt: new Date().toISOString()
      }
    });

    try {
      const listed = await listInstances(directory);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].instanceId, instanceId);
      assert.equal(listed[0].name, 'socket-only');
      assert.equal(listed[0].workspace, '/tmp/socket-only');
      assert.equal(listed[0].verified, true);
    } finally {
      await control.close();
      await removeInstanceRecord(instanceId, directory);
    }
  });
});

test('a reused/live PID without the bdxa control socket is treated as stale', async () => {
  await withTempDir(async (directory) => {
    const instanceId = createInstanceId();
    await saveInstance({
      instanceId,
      name: 'stale-pid',
      workspace: '/tmp/stale-pid',
      mode: 'background',
      pid: process.pid,
      status: 'connected',
      startedAt: new Date(Date.now() - 60_000).toISOString()
    }, directory);

    const [listed] = await listInstances(directory);
    assert.equal(listed.pidAlive, true);
    assert.equal(listed.verified, false);
    assert.equal(listed.live, false);
    assert.equal(listed.status, 'exited');
  });
});

test('instance name claims are atomic and can be released', async () => {
  await withTempDir(async (directory) => {
    const firstId = createInstanceId();
    const secondId = createInstanceId();
    const first = await claimInstanceName('/tmp/backend', 'backend', firstId, directory);
    assert.equal(first, 'backend');
    await assert.rejects(() => claimInstanceName('/tmp/backend', 'backend', secondId, directory), /already running/);
    await releaseInstanceName(first, firstId, directory);
    assert.equal(await claimInstanceName('/tmp/backend', 'backend', secondId, directory), 'backend');
    await releaseInstanceName('backend', secondId, directory);
  });
});

test('process parser recognizes agent invocations and ignores management commands', () => {
  assert.deepEqual(
    parseBdxaAgentProcessCommand('node /opt/node_modules/@buildifyx/desktop-agent/src/cli.js --root /tmp/backend --instance-id inst_abc --instance-name backend --background-child'),
    { instanceId: 'inst_abc', name: 'backend', root: '/tmp/backend', mode: 'background' }
  );
  assert.deepEqual(
    parseBdxaAgentProcessCommand('node ./src/cli.js'),
    { instanceId: null, name: null, root: null, mode: 'foreground' }
  );
  assert.equal(parseBdxaAgentProcessCommand('node ./src/cli.js ls'), null);
  assert.equal(parseBdxaAgentProcessCommand('node ./src/cli.js status'), null);
});