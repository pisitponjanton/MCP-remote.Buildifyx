// Release-only: validate the browser flow using the npm-installed tarball,
// not the checkout. Invoke with an isolated install prefix under the system temp dir.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { requireIsolatedReleasePrefix } from './release-temp-prefix.js';

const prefix = requireIsolatedReleasePrefix(process.argv[2]);
const installed = path.join(prefix, 'node_modules', '@buildifyx', 'desktop-agent');
const requireInstalled = createRequire(path.join(installed, 'package.json'));
const load = file => import(pathToFileURL(path.join(installed, file)).href);
const pkg = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
const playwrightVersion = requireInstalled('playwright/package.json').version;
assert.equal(pkg.version, '0.4.0');
assert.equal(pkg.dependencies.playwright, playwrightVersion,
  'Installed Playwright must match the exact pinned agent dependency');
const { chromium } = requireInstalled('playwright');
assert.equal(existsSync(chromium.executablePath()), true,
  'Matching Chromium is absent; explicitly run the installed bdxa browser install command first');

const { createRuntime } = await load('src/core/runtime.js');
const { createArtifactCache } = await load('src/cache/store.js');
const { normalizePolicy } = await load('src/permissions/policy.js');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'bdxa-release-browser-'));
const workspace = path.join(temporary, 'workspace');
const homeDirectory = path.join(temporary, 'state');
await mkdir(workspace);
const http = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end('<!doctype html><title>Tarball browser smoke</title><h1 id="test">Browser works</h1>');
});
const cache = createArtifactCache({ workspaceRoot: workspace, namespace: 'local', homeDirectory });
const policy = normalizePolicy({ categories: {
  browserRead: 'allow', browserNavigate: 'allow', browserCapture: 'allow',
  imageRead: 'allow', cacheManage: 'allow'
} });
const runtime = createRuntime({
  root: workspace, namespace: 'local', instanceId: 'inst_release_browser',
  principalId: 'principal_release_browser', browserOptions: { homeDirectory },
  imageCache: cache, policy, interactive: false
});
try {
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + http.address().port + '/';
  const session = await runtime.dispatch('browser_open', { url });
  const snapshot = await runtime.dispatch('browser_snapshot', { sessionId: session.sessionId });
  assert.match(snapshot.text, /Browser works/);
  const screenshot = await runtime.dispatch('browser_screenshot', { sessionId: session.sessionId });
  assert.equal(screenshot.mimeType, 'image/png');
  assert.ok(screenshot.width > 0 && screenshot.height > 0);
  const artifact = await cache.get(screenshot.artifactId);
  assert.equal(artifact.data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  await runtime.dispatch('browser_close', { sessionId: session.sessionId });
  console.log(JSON.stringify({
    passed: true, agentVersion: pkg.version, node: process.version,
    playwrightVersion, chromiumPath: chromium.executablePath(),
    flow: 'browser_open -> browser_snapshot -> browser_screenshot -> browser_close',
    screenshot: { width: screenshot.width, height: screenshot.height, bytes: artifact.data.length }
  }, null, 2));
} finally {
  await runtime.stop().catch(() => undefined);
  cache.close();
  await new Promise(resolve => http.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
