import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isAllowedLocalRequest } from '../../src/local/gateway-server.js';
import {
  DEFAULT_LOCAL_PORT,
  localGatewayChildArgs,
  parseLocalPort,
  readLocalGatewayConfig,
  writeLocalGatewayConfig
} from '../../src/local/gateway-control.js';
import { resolveWorkspaceTarget } from '../../src/local/workspace-routing.js';

function request(host, origin) {
  return { headers: { host, ...(origin ? { origin } : {}) } };
}



test('local gateway child argv never contains the shutdown control secret', () => {
  const args = localGatewayChildArgs({ cliEntry: '/opt/bdxa/src/cli.js', port: 3333, gatewayId: 'localgw_test' });
  assert.deepEqual(args, ['/opt/bdxa/src/cli.js', '__local-gateway', '--port', '3333', '--gateway-id', 'localgw_test']);
  assert.equal(args.includes('--control-token'), false);
});
test('local gateway accepts only loopback Host and Origin values', () => {
  assert.equal(isAllowedLocalRequest(request('127.0.0.1:3333')), true);
  assert.equal(isAllowedLocalRequest(request('localhost:3333', 'http://localhost:3000')), true);
  assert.equal(isAllowedLocalRequest(request('[::1]:3333', 'http://[::1]:3000')), true);
  assert.equal(isAllowedLocalRequest(request('example.com:3333')), false);
  assert.equal(isAllowedLocalRequest(request('127.0.0.1:3333', 'https://example.com')), false);
  assert.equal(isAllowedLocalRequest(request('127.0.0.2:3333')), false);
});

test('local gateway port config defaults to 3333 and persists an explicit port privately', async () => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), 'bdxa-local-gateway-'));
  const environment = { rootDirectory };
  try {
    assert.equal(parseLocalPort(), DEFAULT_LOCAL_PORT);
    assert.throws(() => parseLocalPort(0), /Invalid local gateway port/);
    assert.throws(() => parseLocalPort(65536), /Invalid local gateway port/);
    assert.deepEqual(await readLocalGatewayConfig(environment), { port: 3333 });
    await writeLocalGatewayConfig(environment, { port: 43210 });
    assert.deepEqual(await readLocalGatewayConfig(environment), { port: 43210 });
    const file = await readFile(path.join(rootDirectory, 'gateway-config.json'), 'utf8');
    assert.equal(JSON.parse(file).port, 43210);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test('local workspace routing supports target, workspace and device selectors', () => {
  const targets = [
    { targetId: 'local:one', instanceId: 'one', name: 'api', path: '/tmp/api', deviceId: 'mac', deviceName: 'Mac' },
    { targetId: 'local:two', instanceId: 'two', name: 'web', path: '/tmp/web', deviceId: 'mac', deviceName: 'Mac' }
  ];
  assert.equal(resolveWorkspaceTarget(targets, { targetId: 'local:two' }).instanceId, 'two');
  assert.equal(resolveWorkspaceTarget(targets, { workspace: 'api' }).instanceId, 'one');
  assert.throws(() => resolveWorkspaceTarget(targets, { device: 'mac' }), /multiple local instances/i);
  assert.throws(() => resolveWorkspaceTarget(targets, {}), /use use_workspace first/i);
});
