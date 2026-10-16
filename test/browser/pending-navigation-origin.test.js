import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { guardBrowserContext } from '../../src/browser/network.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function server(handler) {
  const s = createServer(handler);
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  return { url: 'http://127.0.0.1:' + s.address().port,
    close: async () => { s.closeAllConnections?.(); await new Promise(r => s.close(r)); } };
}

test('Pending origin: no old-document request reaches newly approved origin before explicit navigation', { timeout: 45000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium unavailable');
  let beaconHits = 0, pixelHits = 0;
  const destination = await server((req, res) => {
    if (req.url?.startsWith('/beacon')) { beaconHits++; res.end('GET side effect'); return; }
    if (req.url === '/begin') { res.writeHead(302, { Location: '/landing' }); res.end(); return; }
    if (req.url === '/pixel') { pixelHits++; res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<title>Trusted Landing</title><img src="/pixel"><h1>Arrived</h1>');
  });
  const source = await server((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<title>Old Page</title><script>setInterval(()=>{new Image().src="' +
      destination.url + '/beacon?old="+Math.random()},5)</script>');
  });
  let browser, guard;
  t.after(async () => { guard?.close(); await browser?.close(); await source.close(); await destination.close(); });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  guard = await guardBrowserContext(context);
  await guard.allowNavigation(source.url + '/', page);
  const first = await page.goto(source.url + '/', { waitUntil: 'domcontentloaded' });
  assert.equal(guard.confirmNavigation(page, source.url + '/', first), true);
  await sleep(95);
  assert.equal(beaconHits, 0, 'different-origin requests before approval blocked');

  // Deliberate permission to navigate does NOT mean an old page may send
  // unrelated GET requests to the new origin before page.goto even starts.
  await guard.allowNavigation(destination.url + '/begin', page);
  await sleep(175);
  assert.equal(page.url(), source.url + '/', 'old document is still alive');
  assert.equal(beaconHits, 0, 'old page must not use pending destination origin');

  // The guard renders a harmless stub for each verified HTTP redirect.
  // Only trusted Agent navigation may consume its next target and start a
  // freshly intercepted document request; Chromium cannot follow unchecked.
  const intermediate = await page.goto(destination.url + '/begin', { waitUntil: 'domcontentloaded' });
  assert.equal(intermediate.status(), 200);
  assert.equal(guard.confirmNavigation(page, page.url(), intermediate), false,
    'a redirect stub is never final authorization');
  const redirect = guard.takeRedirect(page, destination.url + '/begin');
  assert.equal(redirect, destination.url + '/landing');
  await guard.allowNavigation(redirect, page);
  const navigation = await page.goto(redirect, { waitUntil: 'load' });
  assert.equal(navigation.status(), 200);
  assert.equal(page.url(), redirect);
  assert.ok(pixelHits > 0, 'new document resources must load before Agent confirms navigation');
  assert.equal(guard.confirmNavigation(page, page.url(), navigation), true);
  assert.equal(await page.title(), 'Trusted Landing');
  assert.equal(beaconHits, 0);
});

test('Pending origin: cancel revokes grant, and another tab cannot borrow it', { timeout: 35000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium unavailable');
  let leaked = 0;
  const destination = await server((req, res) => {
    if (req.url?.startsWith('/beacon')) leaked++;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<title>New</title>');
  });
  const source = await server((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<title>Old</title><script>setInterval(()=>new Image().src="' +
      destination.url + '/beacon?x="+Math.random(),8)</script>');
  });
  let browser, guard;
  t.after(async () => { guard?.close(); await browser?.close(); await source.close(); await destination.close(); });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const a = await context.newPage();
  const b = await context.newPage();
  guard = await guardBrowserContext(context);
  await guard.allowNavigation(source.url + '/', a);
  const first = await a.goto(source.url + '/', { waitUntil: 'domcontentloaded' });
  assert.equal(guard.confirmNavigation(a, source.url + '/', first), true);
  await guard.allowNavigation(destination.url + '/landing', b);
  await sleep(110);
  assert.equal(leaked, 0, 'approval in tab B does not apply to tab A');
  guard.cancelNavigation(b);
  await guard.allowNavigation(destination.url + '/landing', a);
  await sleep(110);
  assert.equal(leaked, 0, 'tab A old script cannot leak while navigation pending');
  guard.cancelNavigation(a);
  await sleep(110);
  assert.equal(leaked, 0, 'cancelled navigation must not leave destination approved');
});

test('Pending origin: redirected navigation cannot reach an unapproved third-party origin on a second hop', { timeout: 35000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium unavailable');
  let forbiddenHits = 0;
  const forbidden = await server((_req, res) => {
    forbiddenHits++;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<title>Forbidden Third Origin</title>');
  });
  const middle = await server((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { Location: '/second-hop' }); res.end(); return; }
    if (req.url === '/second-hop') { res.writeHead(302, { Location: forbidden.url + '/leak' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<title>Middle</title>');
  });
  // Exercise production browser_open instead of a direct page.goto, since
  // only the trusted Agent may follow an intercepted redirect stub.
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createRuntime } = await import('../../src/core/runtime.js');
  const { normalizePolicy } = await import('../../src/permissions/policy.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-phase18-hop-'));
  const runtime = createRuntime({
    root, interactive: false, instanceId: 'inst_redirect',
    principalId: 'phase18-proof', policy: normalizePolicy({
      categories: { browserNavigate: 'allow', browserRead: 'allow', browserExternal: 'allow' }
    })
  });
  t.after(async () => {
    await runtime.stop().catch(() => undefined);
    await middle.close(); await forbidden.close();
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(
    runtime.dispatch('browser_open', { url: middle.url + '/start' }),
    { code: 'BROWSER_NAVIGATION_FAILED' }
  );
  assert.equal(forbiddenHits, 0,
    'third-party HTTP redirect must be rejected before any network IO');
});

test('Trusted Agent: two same-origin HTTP redirects reach final document and load assets once', { timeout: 45000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium unavailable');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createRuntime } = await import('../../src/core/runtime.js');
  const { normalizePolicy } = await import('../../src/permissions/policy.js');
  const hits = { start: 0, middle: 0, final: 0, pixel: 0 };
  const s = await server((req, res) => {
    if (req.url === '/start') { hits.start++; res.writeHead(302, { Location: '/middle' }); res.end(); return; }
    if (req.url === '/middle') { hits.middle++; res.writeHead(302, { Location: '/final' }); res.end(); return; }
    if (req.url === '/pixel') { hits.pixel++; res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')); return; }
    if (req.url === '/final') { hits.final++; res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<title>Trusted final</title><h1>Finished</h1><img src="/pixel">'); return; }
    res.writeHead(404); res.end('Not found');
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-phase18-redirect-'));
  const runtime = createRuntime({
    root, interactive: false, instanceId: 'inst_redirect_ok',
    principalId: 'phase18-proof', policy: normalizePolicy({
      categories: { browserNavigate: 'allow', browserRead: 'allow' }
    })
  });
  t.after(async () => { await runtime.stop().catch(() => undefined); await s.close();
    await rm(root, { recursive: true, force: true }); });
  const opened = await runtime.dispatch('browser_open', { url: s.url + '/start' });
  assert.equal(opened.url, s.url);
  const snapshot = await runtime.dispatch('browser_snapshot', { sessionId: opened.sessionId });
  assert.match(snapshot.title, /Trusted final/);
  assert.match(snapshot.text, /Finished/);
  assert.deepEqual(hits, { start: 1, middle: 1, final: 1, pixel: 1 },
    'no navigation hop or asset should be fetched twice for preflight');
});

test('Trusted Agent: redirect loops stop after bounded checked hops', { timeout: 35000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium unavailable');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createRuntime } = await import('../../src/core/runtime.js');
  const { normalizePolicy } = await import('../../src/permissions/policy.js');
  let hits = 0;
  const s = await server((_req, res) => {
    hits++;
    res.writeHead(302, { Location: '/loop' });
    res.end();
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-phase18-redirect-loop-'));
  const runtime = createRuntime({
    root, interactive: false, instanceId: 'inst_redirect_loop',
    principalId: 'phase18-proof', policy: normalizePolicy({
      categories: { browserNavigate: 'allow', browserRead: 'allow' }
    })
  });
  t.after(async () => {
    await runtime.stop().catch(() => undefined);
    await s.close();
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(runtime.dispatch('browser_open', { url: s.url + '/loop' }),
    { code: 'BROWSER_NAVIGATION_FAILED' });
  assert.equal(hits, 8, 'redirect chain stops before a ninth request');
});

test('History API cannot forge a new document commit during delayed Chromium route.fulfill', { timeout: 45000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium unavailable');
  let unsafeHits = 0, pixelHits = 0;
  const local = await server((req, res) => {
    if (req.url?.startsWith('/unsafe')) { unsafeHits++; res.end('unsafe GET'); return; }
    if (req.url === '/pixel') {
      pixelHits++;
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (req.url === '/old') {
      res.end('<title>Old Document</title><script>' +
        'window.fire=false;setInterval(()=>{if(!window.fire)return;' +
        'history.replaceState({},"","/target");' +
        'new Image().src="/unsafe?"+Math.random()},3)' +
        '</script><h1>Old page</h1>');
      return;
    }
    res.end('<title>New Document</title><h1>Trusted new page</h1><img src="/pixel">');
  });
  let browser, guard;
  t.after(async () => {
    guard?.close();
    await browser?.close();
    await local.close();
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  // Keep the old DOM alive for a deterministic window after the expected
  // main document has been route.fetch'd but before route.fulfill commits it.
  const wrapped = {
    route: (pattern, callback) => context.route(pattern, route => {
      if (route.request().url() !== local.url + '/target') return callback(route);
      return callback({
        request: () => route.request(),
        fetch: (...args) => route.fetch(...args),
        abort: (...args) => route.abort(...args),
        fulfill: async (...args) => { await sleep(300); return route.fulfill(...args); }
      });
    }),
    routeWebSocket: (...args) => context.routeWebSocket(...args),
    on: (...args) => context.on(...args),
    off: (...args) => context.off(...args),
    newCDPSession: (...args) => context.newCDPSession(...args)
  };
  const page = await context.newPage();
  guard = await guardBrowserContext(wrapped);
  await guard.allowNavigation(local.url + '/old', page);
  const previous = await page.goto(local.url + '/old', { waitUntil: 'domcontentloaded' });
  assert.equal(guard.confirmNavigation(page, page.url(), previous), true);
  await guard.withSafeInteraction(page, async () => undefined);
  assert.equal(unsafeHits, 0);
  await guard.allowNavigation(local.url + '/target', page);
  await page.evaluate(() => { window.fire = true; });
  const target = await page.goto(local.url + '/target', { waitUntil: 'load', timeout: 8000 });
  assert.equal(target.status(), 200);
  assert.equal(unsafeHits, 0,
    'History API events cannot release old-document image GETs while new response is pending');
  assert.ok(pixelHits > 0, 'actual committed new document must load its image');
  assert.equal(guard.confirmNavigation(page, page.url(), target), true);
  assert.equal(await page.title(), 'New Document');
});

test('CDP document-commit verification unavailable: no navigation grant is created', async () => {
  const context = { async route() {}, async routeWebSocket() {}, on() {}, off() {} };
  const page = { isClosed: () => false };
  const guard = await guardBrowserContext(context);
  try {
    await assert.rejects(guard.allowNavigation('http://127.0.0.1:30303/test', page),
      { code: 'BROWSER_URL_DENIED' });
    assert.equal(guard.allowedOriginCount, 0, 'no privileged destination may be granted without CDP');
  } finally { guard.close(); }
});

test('Same-document hash navigation cannot release safe-locked old page (real Chromium)', { timeout: 40000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium unavailable');
  let unsafeHits = 0;
  const site = await server((req, res) => {
    if (req.url?.startsWith('/unsafe')) { unsafeHits++; res.end('unsafe'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<title>Same Document</title><h1>Old live page</h1>' +
      '<script>window.fire = false;setInterval(()=>{if(window.fire)' +
      'new Image().src="/unsafe?"+Math.random()},5)</script>');
  });
  let browser, guard;
  t.after(async () => { guard?.close(); await browser?.close(); await site.close(); });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  guard = await guardBrowserContext(context);
  await guard.allowNavigation(site.url + '/old', page);
  const initial = await page.goto(site.url + '/old', { waitUntil: 'domcontentloaded' });
  assert.equal(guard.confirmNavigation(page, page.url(), initial), true);
  await guard.withSafeInteraction(page, async () => undefined);
  await page.evaluate(() => { window.fire = true; });
  await sleep(90);
  assert.equal(unsafeHits, 0, 'old page is network locked before fragment navigation');

  await guard.allowNavigation(site.url + '/old#fragment', page);
  const sameDocument = await page.goto(site.url + '/old#fragment', { waitUntil: 'domcontentloaded' });
  assert.equal(sameDocument, null, 'Playwright fragment navigation has no new HTTP response');
  assert.equal(guard.confirmNavigation(page, page.url(), sameDocument), false,
    'a response-less fragment cannot confirm a new loader or unlock old script');
  await sleep(160);
  assert.equal(unsafeHits, 0, 'old document remains locked after attempted fragment navigation');
  assert.match(await page.locator('h1').innerText(), /Old live page/);
});

test('Trusted Agent browser_navigate to same document hash fails closed without unlocking old page', { timeout: 45000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium unavailable');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createRuntime } = await import('../../src/core/runtime.js');
  const { normalizePolicy } = await import('../../src/permissions/policy.js');
  let unsafeHits = 0;
  const site = await server((req, res) => {
    if (req.url?.startsWith('/unsafe')) { unsafeHits++; res.end('unsafe'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<title>Old live doc</title><button id="safe">Safe click</button>' +
      '<h1>Old page</h1><script>window.fire=false;' +
      'document.querySelector("#safe").addEventListener("click",()=>window.fire=true);' +
      'setInterval(()=>{if(window.fire)new Image().src="/unsafe?"+Math.random()},5)' +
      '</script>');
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-phase18-hash-'));
  const runtime = createRuntime({
    root, interactive: false, instanceId: 'inst_hash_test',
    principalId: 'phase18-hash', policy: normalizePolicy({
      categories: { browserNavigate: 'allow', browserRead: 'allow', browserInteract: 'allow' }
    })
  });
  t.after(async () => {
    await runtime.stop().catch(() => undefined);
    await site.close();
    await rm(root, { recursive: true, force: true });
  });
  const opened = await runtime.dispatch('browser_open', { url: site.url + '/old' });
  const sid = opened.sessionId;
  await runtime.dispatch('browser_click', { sessionId: sid, target: { selector: '#safe' } });
  await sleep(100);
  assert.equal(unsafeHits, 0, 'safe click cannot send GET beacons');
  await assert.rejects(runtime.dispatch('browser_navigate', {
    sessionId: sid, url: site.url + '/old#fragment'
  }), { code: 'BROWSER_NAVIGATION_FAILED' });
  await sleep(120);
  assert.equal(unsafeHits, 0, 'failed same-document navigation does not unlock GETs');
  const snapshot = await runtime.dispatch('browser_snapshot', { sessionId: sid });
  assert.match(snapshot.text, /Old page/);
});
