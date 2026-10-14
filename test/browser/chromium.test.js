import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { createBrowserSessionEngine, validateBrowserUrl } from '../../src/browser/session-engine.js';

test('real Chromium opens localhost, isolates temporary contexts, and preserves only explicitly approved persistent profile', { timeout: 60_000 }, async t => {
  if (!existsSync(chromium.executablePath())) {
    t.skip('Chromium browser binary not installed; install with npx playwright install chromium.');
    return;
  }
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-chromium-')));
  const root = path.join(base, 'workspace');
  const home = path.join(base, 'home');
  await mkdir(root);
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>BuildifyX Local Test</title><main>localhost browser engine works</main>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const scope = { instanceId: 'inst_smoke', principalId: 'principal_smoke' };
  const opts = { workspaceRoot: root, homeDirectory: home, ...scope, persistentConsent: async () => true };
  let first;
  let second;
  t.after(async () => {
    await first?.closeAll().catch(() => undefined);
    await second?.closeAll().catch(() => undefined);
    await new Promise(resolve => server.close(resolve));
    await rm(base, { recursive: true, force: true });
  });
  const url = validateBrowserUrl('http://127.0.0.1:' + port + '/');
  first = createBrowserSessionEngine(opts);
  const temporary = await first.open({ scope });
  const title = await first.withSession(temporary.sessionId, async ({ context }) => {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(url);
    return page.title();
  }, { scope });
  assert.equal(title, 'BuildifyX Local Test');
  const cookie = { name: 'session', value: 'local-only', url, expires: Math.floor(Date.now() / 1000) + 86400 };
  await first.withSession(temporary.sessionId, async ({ context }) => context.addCookies([cookie]), { scope });
  const otherTemp = await first.open({ scope });
  const otherCookies = await first.withSession(otherTemp.sessionId, async ({ context }) => context.cookies(url), { scope });
  assert.equal(otherCookies.some(c => c.name === 'session'), false);
  await first.closeSession(temporary.sessionId, { scope });
  await first.closeSession(otherTemp.sessionId, { scope });
  const saved = await first.open({ scope, kind: 'persistent', profileName: 'localhost-test', confirmPersistent: true });
  await first.withSession(saved.sessionId, async ({ context }) => {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(url);
    await context.addCookies([cookie]);
    assert.equal((await context.cookies(url)).find(c => c.name === 'session')?.value, 'local-only');
    await page.reload();
  }, { scope });
  await first.closeSession(saved.sessionId, { scope });
  const sessionRoot = path.join(home, 'browser', 'v1', 'sessions');
  const ownerFolders = await readdir(sessionRoot);
  assert.equal(ownerFolders.length, 1);
  assert.deepEqual(await readdir(path.join(sessionRoot, ownerFolders[0])), []);
  await first.closeAll();
  second = createBrowserSessionEngine(opts);
  const reused = await second.open({ scope, kind: 'persistent', profileName: 'localhost-test', confirmPersistent: true });
  const cookies = await second.withSession(reused.sessionId, ({ context }) => context.cookies(url), { scope });
  assert.equal(cookies.find(c => c.name === 'session')?.value, 'local-only');
  await second.closeAll();
  const profilesRoot = path.join(home, 'browser', 'v1', 'profiles');
  assert.equal((await readdir(profilesRoot)).length, 1);
  assert.equal((await readdir(root)).length, 0);
});
