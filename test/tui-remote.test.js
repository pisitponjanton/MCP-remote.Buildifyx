import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteDashboardState } from '../src/tui/remote.js';

function dashboard(status = 'connected') {
  return {
    version: '0.2.1',
    root: '/tmp/workspace',
    instanceId: 'inst_remote_test',
    instanceName: 'remote-test',
    accessMode: 'Restricted commands',
    events: [{
      id: `cloud-${status}`,
      type: 'cloud.connection',
      timestamp: '2026-01-01T00:00:00.000Z',
      status
    }],
    approvals: [],
    policy: { categories: {}, additionalRoots: [], commandRules: [] },
    connection: { status }
  };
}

test('attached dashboard retries after a transient local control failure', async () => {
  let calls = 0;
  const seen = [];
  const request = async () => {
    calls += 1;
    if (calls === 1) throw new Error('temporary control failure');
    return { ok: true, dashboard: dashboard('connected') };
  };
  const remote = createRemoteDashboardState(
    { instanceId: 'inst_remote_test', controlPath: '/tmp/not-used.sock' },
    dashboard('connected'),
    { request, retryDelayMs: 0, now: () => 0 }
  );
  remote.eventBus.subscribe((event) => seen.push(event));

  await remote.refresh();
  assert.equal(calls, 1);
  assert.equal(remote.stopped, false);
  assert.equal(remote.eventBus.getHistory().at(-1).status, 'disconnected');

  await remote.refresh();
  assert.equal(calls, 2);
  assert.equal(remote.stopped, false);
  assert.equal(remote.eventBus.getHistory().at(-1).status, 'connected');
  assert.equal(remote.eventBus.getHistory().at(-1).localControlRecovered, true);
  assert.equal(seen.some((event) => event.status === 'disconnected'), true);
  assert.equal(seen.some((event) => event.localControlRecovered), true);
});
