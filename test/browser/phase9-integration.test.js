import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { createRuntime } from '../../src/core/runtime.js';
import { createArtifactCache } from '../../src/cache/store.js';
import { normalizePolicy } from '../../src/permissions/policy.js';

const sharp = createRequire(import.meta.url)('sharp');

const policy = normalizePolicy({ categories: {
  browserRead: 'allow', browserNavigate: 'allow', browserInteract: 'allow',
  browserCapture: 'allow', browserDiagnostics: 'allow',
  browserSensitive: 'deny', browserExternal: 'deny', persistentProfile: 'allow',
  imageRead: 'allow', imageSave: 'allow', cacheManage: 'allow', outsideRoot: 'deny'
}});
async function setup(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-p9-int-')));
  const home = path.join(base, 'home');
  const root = path.join(base, 'one');
  const other = path.join(base, 'two');
  await mkdir(root); await mkdir(other);
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ url: req.url, cookie: req.headers.cookie ?? '' });
    res.setHeader('content-type','text/html');
    res.setHeader('set-cookie', 'buildifyx_p9=persisted; Path=/; Max-Age=3600; SameSite=Lax');
    res.end('<title>Phase9 UI</title><main>Connected and saved</main>');
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  const created = [];
  function start(workspaceRoot = root, namespace = 'local', principalId = 'user_p9') {
    const cache = createArtifactCache({ workspaceRoot, namespace, homeDirectory: home });
    const runtime = createRuntime({ root: workspaceRoot, namespace, imageCache: cache, policy, interactive: false,
      instanceId: 'inst_phase9', principalId,
      browserOptions: { homeDirectory: home } });
    created.push({ cache, runtime });
    return { cache, runtime };
  }
  t.after(async () => {
    for (const { cache, runtime } of created.reverse()) {
      await runtime.stop().catch(() => undefined);
      cache.close();
    }
    await new Promise(resolve => server.close(resolve));
    await rm(base,{recursive:true,force:true});
  });
  return { base, home, root, other, url, hits, start };
}

test('Phase 9 integration: browser capture -> temporary cache -> explicit permanent save -> agent restart and persistent profile restore', { timeout: 60000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium unavailable on this host');
  const f = await setup(t);
  const one = f.start();
  const started = await one.runtime.dispatch('browser_open', { url: f.url });
  const temporaryId = started.sessionId;
  const screenshot = await one.runtime.dispatch('browser_screenshot', { sessionId: temporaryId });
  assert.equal(screenshot.mimeType, 'image/png');
  const { artifactId } = screenshot;
  assert.equal((await one.cache.get(artifactId)).metadata.kind, 'screenshot');
  const output = await one.runtime.dispatch('save_cached_image', { artifactId, destinationPath: 'only-by-request.png' });
  assert.equal(output.saved, true);
  const durable = await readFile(path.join(f.root,'only-by-request.png'));
  assert.equal(durable.subarray(0,8).toString('hex'), '89504e470d0a1a0a');
  await assert.rejects(one.runtime.dispatch('save_cached_image', { artifactId, destinationPath: 'only-by-request.png' }), { code: 'IMAGE_EXISTS' });
  const persistent = await one.runtime.dispatch('browser_open', {
    kind: 'persistent', profileName: 'approved-session', confirmPersistent: true, url: f.url
  });
  await one.runtime.dispatch('browser_snapshot', { sessionId: persistent.sessionId });
  await one.runtime.dispatch('browser_close', { sessionId: persistent.sessionId });
  await one.runtime.stop();
  one.cache.close();

  const two = f.start();
  await assert.rejects(two.runtime.dispatch('browser_snapshot', { sessionId: temporaryId }), { code: 'BROWSER_SESSION_NOT_FOUND' });
  const sameAsset = await two.runtime.dispatch('get_cached_image', { artifactId });
  assert.equal(sameAsset.sha256, screenshot.sha256);
  const restored = await two.runtime.dispatch('browser_open', {
    kind: 'persistent', profileName: 'approved-session', confirmPersistent: true, url: f.url
  });
  assert.equal(restored.kind, 'persistent');
  assert.ok(f.hits.some(hit => hit.cookie.includes('buildifyx_p9=persisted')),
    'Consented persistent local browser profile should restore its cookie after agent restart');
  await two.runtime.dispatch('browser_close', { sessionId: restored.sessionId });
  await two.runtime.dispatch('clear_cache', {});
  await assert.rejects(two.runtime.dispatch('get_cached_image', { artifactId }));
  assert.deepEqual(await readFile(path.join(f.root,'only-by-request.png')), durable);
  const browserRoot = path.join(f.home,'browser','v1','profiles');
  assert.equal((await readdir(browserRoot)).length, 1, 'Image cache cleanup must not delete consented browser profile owner directory');
});

test('Phase 9 integration: workspace, namespace and principal fences prevent cross-owner reuse', { timeout: 60000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium unavailable on this host');
  const f = await setup(t);
  const first = f.start();
  await writeFile(path.join(f.root, 'source.png'), await sharp({create:{width:16,height:12,channels:3,background:'#445566'}}).png().toBuffer());
  const imported = await first.runtime.dispatch('read_image', { path: 'source.png' });
  const session = await first.runtime.dispatch('browser_open', { url: f.url });
  const foreignWorkspace = f.start(f.other);
  const cloudNamespace = f.start(f.root, 'cloud');
  const foreignPrincipal = f.start(f.root, 'local', 'other_user');
  for (const guest of [foreignWorkspace, cloudNamespace]) {
    await assert.rejects(guest.runtime.dispatch('get_cached_image', {artifactId: imported.artifactId}));
    await assert.rejects(guest.runtime.dispatch('browser_snapshot', {sessionId:session.sessionId}), {code:'BROWSER_SESSION_NOT_FOUND'});
  }
  await assert.rejects(foreignPrincipal.runtime.dispatch('browser_snapshot', {sessionId: session.sessionId}), {code:'BROWSER_SESSION_NOT_FOUND'});
  // Artifact cache is workspace/device/namespace-owned. Browser profiles additionally include the principal.
  const left = await first.runtime.dispatch('browser_open', {kind:'persistent',profileName:'same',confirmPersistent:true});
  const right = await foreignPrincipal.runtime.dispatch('browser_open', {kind:'persistent',profileName:'same',confirmPersistent:true});
  assert.notEqual(left.profileKey, undefined);
  assert.equal(right.kind,'persistent');
  await first.runtime.dispatch('browser_close',{sessionId:left.sessionId});
  await foreignPrincipal.runtime.dispatch('browser_close',{sessionId:right.sessionId});
});
