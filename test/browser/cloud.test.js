import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { createCloudAgent } from '../../src/transport/cloud.js';
import { createRuntime } from '../../src/core/runtime.js';
import { normalizePolicy } from '../../src/permissions/policy.js';
import { createToolManifest } from '../../src/transport/mcp/tools/registry.js';

test('authenticated Cloud mock relays Browser Tools through Agent Protocol v2 without media negotiation', { timeout: 60000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium unavailable');
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-cloud-browser-')));
  const root = path.join(base, 'workspace');
  await mkdir(root);
  const http = createServer((_, res) => { res.setHeader('content-type','text/html'); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><title>Cloud Mock</title><h1>Cloud Browser Works</h1>'); });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const pageUrl = 'http://127.0.0.1:' + http.address().port + '/';
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => ws.once('listening', resolve));
  const policy = normalizePolicy({ categories: { browserNavigate: 'allow', browserRead: 'allow', browserCapture: 'allow', browserDiagnostics: 'allow' } });
  const runtime = createRuntime({ root, instanceId: 'inst_cloud_browser', principalId: 'cloud_mock_device',
    policy, interactive: false, browserOptions: { homeDirectory: path.join(base, 'state') } });
  const messages = [];
  const finished = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Cloud browser mock timed out')), 25000);
    ws.on('connection', (socket, request) => {
      assert.equal(request.headers.authorization, 'Bearer cloud-test-token');
      socket.on('message', raw => {
        const message = JSON.parse(raw.toString());
        messages.push(message);
        if (message.type === 'device.ready') {
          assert.equal(message.protocolVersion, 2);
          socket.send(JSON.stringify({ type: 'tool.call', requestId: 'browser-1', instanceId: 'inst_cloud_browser',
            tool: 'browser_open', arguments: { url: pageUrl } }));
        } else if (message.type === 'tool.result' && message.requestId === 'browser-1') {
          socket.send(JSON.stringify({ type: 'tool.call', requestId: 'browser-2', instanceId: 'inst_cloud_browser',
            tool: 'browser_snapshot', arguments: { sessionId: message.result.sessionId } }));
          assert.equal(message.result.title, 'Cloud Mock');
        } else if (message.type === 'tool.result' && message.requestId === 'browser-2') {
          assert.match(message.result.text, /Cloud Browser Works/);
          const open = messages.find(m => m.requestId === 'browser-1' && m.type === 'tool.result');
          socket.send(JSON.stringify({ type: 'tool.call', requestId: 'browser-3', instanceId: 'inst_cloud_browser',
            tool: 'browser_screenshot', arguments: { sessionId: open.result.sessionId, viewportPreset:'mobile', deviceScaleFactor:2, scale:'device' } }));
        } else if (message.type === 'tool.result' && message.requestId === 'browser-3') {
          assert.equal(message.result.imageBytesDelivered, false);
          assert.equal(message.result.mimeType, 'image/png');
          assert.equal(message.result.width,780);
          assert.equal(message.result.height,1688);
          assert.equal(message.result.deviceScaleFactor,2);
          assert.equal(message.result.mobileLayout,true);
          assert.match(message.result.artifactId, /^art_/);
          assert.equal(message.result.mediaTransfer, undefined);
          const open = messages.find(m => m.requestId === 'browser-1' && m.type === 'tool.result');
          socket.send(JSON.stringify({ type: 'tool.call', requestId: 'browser-4', instanceId: 'inst_cloud_browser',
            tool: 'browser_close', arguments: { sessionId: open.result.sessionId } }));
        } else if (message.type === 'tool.result' && message.requestId === 'browser-4') {
          clearTimeout(timeout);
          resolve(message.result);
        } else if (message.type === 'tool.error') {
          clearTimeout(timeout);
          reject(new Error(JSON.stringify(message)));
        }
      });
    });
  });
  const agent = createCloudAgent({ cloudUrl: 'http://127.0.0.1:' + ws.address().port,
    credentials: { deviceId: 'device', deviceToken: 'cloud-test-token' },
    runtime, manifest: createToolManifest(), version: '0.3.3',
    instance: { instanceId: 'inst_cloud_browser', name: 'test', path: root, mode: 'foreground' },
    deviceInfo: {}, eventBus: { emit: () => {} }, reconnect: false, heartbeatMs: 60000 });
  t.after(async () => {
    await agent.stop().catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    for (const client of ws.clients) client.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => http.close(resolve));
    await rm(base, { recursive: true, force: true });
  });
  agent.connect();
  assert.deepEqual(await finished, { closed: true });
  assert.equal(messages.some(m => m.type.startsWith('media.transfer')), false);
});
