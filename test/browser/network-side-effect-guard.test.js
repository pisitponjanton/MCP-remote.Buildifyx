import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { createRuntime } from '../../src/core/runtime.js';
import { guardBrowserContext } from '../../src/browser/network.js';
import { normalizePolicy } from '../../src/permissions/policy.js';
import { attachMockCdp } from './mock-cdp.js';

async function fixture(t, { sensitive = 'deny', interactive = false } = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-f01-network-')));
  const root = path.join(base, 'workspace');
  await mkdir(root);
  const hits = { get: 0, post: 0 };
  const html = '<title>F01 safe click</title>' +
    '<button id="details" onclick="fetch(\'/unsafe-get\')">Details</button>' +
    '<button id="delayed" onclick="setTimeout(()=>fetch(\'/unsafe-get\'),75)">Preview</button>' +
    '<button id="image" onclick="const img=new Image();img.src=\'/unsafe-get\'">Load graphic</button>' +
    '<button id="cross-tab" onclick="setTimeout(()=>{const i=new Image();i.src=\'/unsafe-get\'},800)">Cross-tab preview</button>' +
    '<button id="post" onclick="fetch(\'/unsafe-post\',{method:\'POST\'})">Show options</button>' +
    '<button id="navigate" onclick="location.href=\'/unsafe-get\'">Help</button>' +
    '<a id="anchor" href="/unsafe-get">Open help</a>' +
    '<button id="local" onclick="document.querySelector(\'#state\').textContent=\'expanded\'">Expand</button>' +
    '<input id="search" oninput="fetch(\'/unsafe-get\')">' +
    '<p id="state">collapsed</p>';
  const server = createServer((req, res) => {
    if (req.url === '/allowed-redirect') { res.writeHead(302, { location: '/redirect-landing' }); res.end(); return; }
    if (req.url === '/redirect-landing') {
      res.setHeader('content-type', 'text/html');
      res.end('<title>F01 redirect landing</title><h1>Redirect completed</h1>');
      return;
    }
    if (req.url === '/unsafe-get') { hits.get++; res.end('mutated'); return; }
    if (req.url === '/unsafe-post') { hits.post++; res.end('mutated'); return; }
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  const runtime = createRuntime({
    root, namespace: 'local', instanceId: 'inst_f01', principalId: 'principal_f01',
    browserOptions: { homeDirectory: path.join(base, 'state') },
    policy: normalizePolicy({ categories: {
      browserNavigate: 'allow', browserRead: 'allow', browserInteract: 'allow',
      browserSensitive: sensitive
    } }),
    interactive
  });
  t.after(async () => {
    await runtime.stop().catch(() => undefined);
    await new Promise(resolve => server.close(resolve));
    await rm(base, { recursive: true, force: true });
  });
  return { runtime, url, hits };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('F01: safe clicks cannot trigger GET/POST mutations, delayed fetch, image beacons, or link navigation', { timeout: 60000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium unavailable');
  const f = await fixture(t);
  // Each denied side-effect/navigation case has its own browser context.
  // A blocked link may asynchronously load Chromium's error document; reusing
  // that page for the next case races a new explicitly requested navigation,
  // especially on slower or emulated CPUs. Isolation also prevents state
  // from a previous click from affecting the next security assertion.
  for (const selector of ['#details', '#delayed', '#image', '#post', '#navigate', '#anchor']) {
    const opened = await f.runtime.dispatch('browser_open', { url: f.url });
    const select = { sessionId: opened.sessionId };
    try {
      await f.runtime.dispatch('browser_click', { ...select, target: { selector } }).catch(error => {
        assert.ok(['BROWSER_CLICK_FAILED', 'BROWSER_SESSION_NOT_FOUND'].includes(error.code), error.message);
      });
      await sleep(180);
      assert.deepEqual(f.hits, { get: 0, post: 0 }, selector + ' must not trigger a server-side side effect');
    } finally {
      await f.runtime.dispatch('browser_close', select);
    }
  }
  const opened = await f.runtime.dispatch('browser_open', { url: f.url });
  const select = { sessionId: opened.sessionId };
  const clicked = await f.runtime.dispatch('browser_click', { ...select, target: { selector: '#local' } });
  assert.equal(clicked.clicked, true);
  const snapshot = await f.runtime.dispatch('browser_snapshot', select);
  assert.match(snapshot.text, /expanded/);
  assert.deepEqual(f.hits, { get: 0, post: 0 });
});

test('F01: explicit navigation after safe click follows a same-origin redirect to the verified landing document', { timeout: 60000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium unavailable');
  const f = await fixture(t);
  const opened = await f.runtime.dispatch('browser_open', { url: f.url });
  const scope = { sessionId: opened.sessionId };
  const clicked = await f.runtime.dispatch('browser_click', {
    ...scope, target: { selector: '#local' }
  });
  assert.equal(clicked.clicked, true);
  const nav = await f.runtime.dispatch('browser_navigate', {
    ...scope, url: f.url + 'allowed-redirect'
  });
  assert.equal(nav.title, 'F01 redirect landing');
  const snapshot = await f.runtime.dispatch('browser_snapshot', scope);
  assert.match(snapshot.text, /Redirect completed/);
  assert.deepEqual(f.hits, { get: 0, post: 0 });
});

test('F01: non-sensitive fill cannot issue GET via input JavaScript event handler', { timeout: 60000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium unavailable');
  const f = await fixture(t);
  const opened = await f.runtime.dispatch('browser_open', { url: f.url });
  const result = await f.runtime.dispatch('browser_fill', {
    sessionId: opened.sessionId, target: { selector: '#search' }, value: 'search'
  });
  assert.equal(result.filled, true);
  await sleep(130);
  assert.deepEqual(f.hits, { get: 0, post: 0 });
});

test('F01: an explicitly confirmed click needs browserSensitive approval and only then permits GET mutation', { timeout: 60000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium unavailable');
  const f = await fixture(t, { sensitive: 'ask', interactive: true });
  const opened = await f.runtime.dispatch('browser_open', { url: f.url });
  const target = { sessionId: opened.sessionId, target: { selector: '#details' } };
  const safe = await f.runtime.dispatch('browser_click', target);
  assert.equal(safe.clicked, true);
  await sleep(120);
  assert.equal(f.hits.get, 0);
  const pending = f.runtime.dispatch('browser_click', { ...target, confirmSensitive: true });
  let approval;
  for (let n = 0; n < 140; n++) {
    approval = f.runtime.approvalQueue.getPending().find(item => item.category === 'browserSensitive');
    if (approval) break;
    await sleep(10);
  }
  assert.equal(approval?.category, 'browserSensitive');
  assert.equal(f.runtime.approvalQueue.resolve(approval.id, { action: 'allow', remember: null }), true);
  const approved = await pending;
  assert.equal(approved.clicked, true);
  for (let n = 0; n < 50 && f.hits.get === 0; n++) await sleep(10);
  assert.equal(f.hits.get, 1);
  await sleep(100);
  assert.equal(f.hits.get, 1, 'Approval must authorize only this one action, not unrelated future requests');
});


test('F01: navigating a different tab must not unlock a delayed image request from the safe-click tab', { timeout: 45000 }, async t => {
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium unavailable');
  const f = await fixture(t);
  const opened = await f.runtime.dispatch('browser_open', { url: f.url });
  const sessionId = opened.sessionId;
  const extra = await f.runtime.dispatch('browser_tabs',{sessionId,action:'new'});
  const otherTab = extra.activeTabId;
  const firstTab = extra.tabs.find(x => x.tabId !== otherTab).tabId;
  await f.runtime.dispatch('browser_click',{sessionId,tabId:firstTab,target:{selector:'#cross-tab'}});
  await f.runtime.dispatch('browser_navigate',{sessionId,tabId:otherTab,url:f.url});
  await sleep(1100);
  assert.deepEqual(f.hits,{get:0,post:0},
    'A fresh navigation in another tab must not authorize the first tab to send delayed GET image mutations');
});


test('F01: one tab sensitive approval never authorizes a different safe-locked tab', async () => {
  const url='http://127.0.0.1:30771/proof';
  const pageA = { id:'a', url:()=>url }, pageB = { id:'b', url:()=>url };
  const mainB = { page:()=>pageB };
  pageB.mainFrame = () => mainB;
  let handler;
  const browserContext = {
    async route(_pattern, fn) { handler = fn; },
    on() {}, off() {},
    async routeWebSocket() {}
  };
  const cdp = attachMockCdp(browserContext);
  const guard = await guardBrowserContext(browserContext);
  await guard.allowNavigation(url,pageA);
  await guard.allowNavigation(url,pageB);
  const mainRequest = {
    url:()=>url, method:()=> 'GET', resourceType:()=> 'document',
    frame:()=>mainB, isNavigationRequest:()=>true, redirectedFrom:()=>null
  };
  await handler({
    request:()=>mainRequest,
    async fetch(){return{status:()=>200,headers:()=>({})}},
    async fulfill(){}, async abort(){throw Error('Fixture main document denied')}
  });
  cdp.commitMainDocument(pageB,url);
  assert.equal(guard.confirmNavigation(pageB,url,{request:()=>mainRequest}), true);
  await guard.withSafeInteraction(pageA,async()=>undefined);
  const createRoute = (page,type='image') => {
    const calls=[];
    return {
      calls,
      request() { return {
        url:()=>url,
        method:()=> 'GET',
        resourceType:()=>type,
        frame:()=>({page:()=>page}),
        isNavigationRequest:()=>false
      }; },
      async fetch() { calls.push('fetch'); return {status:()=>200,headers:()=>({})}; },
      async fulfill() { calls.push('fulfill'); },
      async abort() { calls.push('abort'); }
    };
  };
  let endMutation;
  const mutation=guard.withMutation(pageB,()=>new Promise(resolve=>{endMutation=resolve;}));
  const denied=createRoute(pageA);
  await handler(denied);
  assert.deepEqual(denied.calls,['abort']);
  const approved=createRoute(pageB,'fetch');
  await handler(approved);
  assert.deepEqual(approved.calls,['fetch','fulfill']);
  endMutation();
  await mutation;
  const unapproved=createRoute(pageB,'fetch');
  await handler(unapproved);
  assert.deepEqual(unapproved.calls,['abort']);
  guard.close();
});


test('F01: starting a navigation must not unlock delayed requests from a safely interacted old document', async () => {
  const callbacks = new Map();
  let frameUrl = 'http://127.0.0.1:30771/old';
  const frame = { url: () => frameUrl };
  const page = {
    on(event, cb) { callbacks.set(event, cb); },
    mainFrame() { return frame; },
    url() { return frameUrl; },
    isClosed() { return false; }
  };
  frame.page = () => page;
  let listener;
  const context = {
    async route(_pattern, callback) { listener = callback; },
    on() {}, off() {}, async routeWebSocket() {}
  };
  const cdp = attachMockCdp(context);
  const guard = await guardBrowserContext(context);
  const origin = 'http://127.0.0.1:30771';
  const routeFor = (type, navigation = false, requestFrame = frame, targetPath = navigation ? '/new' : '/delayed-beacon') => {
    const calls = [];
    const request = {
      url: () => origin + targetPath,
      method: () => 'GET',
      resourceType: () => type,
      frame: () => requestFrame,
      isNavigationRequest: () => navigation,
      redirectedFrom: () => null
    };
    return {
      calls, request: () => request,
      async fetch() { calls.push('fetch'); return { status: () => 200, headers: () => ({}) }; },
      async fulfill() { calls.push('fulfill'); },
      async abort() { calls.push('abort'); }
    };
  };
  try {
    await guard.allowNavigation(origin + '/old', page);
    await guard.withSafeInteraction(page, async () => undefined);
    const before = routeFor('image');
    await listener(before);
    assert.deepEqual(before.calls, ['abort']);
    await guard.allowNavigation(origin + '/new', page);
    const delayed = routeFor('image');
    await listener(delayed);
    assert.deepEqual(delayed.calls, ['abort'], 'old page stays network-locked while navigation is only pending');
    const iframeNavigation = routeFor('document', true, { page: () => page });
    await listener(iframeNavigation);
    assert.deepEqual(iframeNavigation.calls, ['abort'], 'iframe navigation must not unlock the old document');
    const unrelatedDocument = routeFor('document', true, frame, '/unsafe-get');
    await listener(unrelatedDocument);
    assert.deepEqual(unrelatedDocument.calls, ['abort'], 'only the explicitly requested document may bypass the pending safe lock');
    const document = routeFor('document', true);
    await listener(document);
    assert.deepEqual(document.calls, ['fetch', 'fulfill'], 'explicit main-document navigation is allowed');
    const sameOriginRedirect = routeFor('document', true, frame, '/new-final');
    const originalRequest = document.request();
    const redirectedRequest = sameOriginRedirect.request();
    sameOriginRedirect.request = () => ({
      ...redirectedRequest, redirectedFrom: () => originalRequest
    });
    await listener(sameOriginRedirect);
    assert.deepEqual(sameOriginRedirect.calls, ['fetch', 'fulfill'],
      'a same-origin HTTP redirect chained to the explicit navigation stays authorized');
    frameUrl = origin + '/unrelated';
    cdp.commitMainDocument(page, frameUrl);
    const unrelatedCommit = routeFor('image');
    await listener(unrelatedCommit);
    assert.deepEqual(unrelatedCommit.calls, ['abort'],
      'an unrelated same-origin main-frame commit cannot release a pending safe lock');
    frameUrl = origin + '/new-final';
    cdp.sameDocumentNavigation(page, frameUrl);
    const spoofedHistory = routeFor('image');
    await listener(spoofedHistory);
    assert.deepEqual(spoofedHistory.calls, ['abort'],
      'History API same-document event with the expected URL must not unlock old-document GETs');
    assert.equal(guard.confirmNavigation(page, frameUrl, {
      request: () => sameOriginRedirect.request()
    }), false, 'a plausible HTTP response without a new CDP loader cannot release the lock');
    cdp.commitMainDocument(page, frameUrl);
    const premature = routeFor('image');
    await listener(premature);
    assert.deepEqual(premature.calls, ['fetch','fulfill'],
      'once the verified main-document response commits, new-page resources may bootstrap before final Agent confirmation');
    assert.equal(guard.confirmNavigation(page, frameUrl), false,
      'a redirect landing cannot be confirmed without a real navigation response');
    assert.equal(guard.confirmNavigation(page, frameUrl, {
      request: () => routeFor('document', true, frame, '/unrelated').request()
    }), false, 'an unrelated same-origin response must not confirm the navigation');
    const stillLocked = routeFor('image');
    await listener(stillLocked);
    assert.deepEqual(stillLocked.calls, ['fetch','fulfill'],
      'verified new-document resources remain available while the Agent inspects redirect provenance');
    assert.equal(guard.confirmNavigation(page, frameUrl, { request: () => sameOriginRedirect.request() }), true);
    const after = routeFor('image');
    await listener(after);
    assert.deepEqual(after.calls, ['fetch', 'fulfill'], 'Agent-confirmed document unlocks the tab');

    await guard.withSafeInteraction(page, async () => undefined);
    await guard.allowNavigation(origin + '/new', page);
    guard.cancelNavigation(page);
    const failed = routeFor('image');
    await listener(failed);
    assert.deepEqual(failed.calls, ['abort'], 'failed navigation must leave the previous document locked');
    const staleNavigation = routeFor('document', true);
    await listener(staleNavigation);
    assert.deepEqual(staleNavigation.calls, ['abort'], 'failed navigation must revoke the pending main-document grant');
  } finally {
    guard.close();
  }
});
