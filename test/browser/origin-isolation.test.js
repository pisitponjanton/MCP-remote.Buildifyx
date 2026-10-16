import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { createRuntime } from '../../src/core/runtime.js';
import { normalizePolicy } from '../../src/permissions/policy.js';
import { authorizeBrowserUrl, guardBrowserContext } from '../../src/browser/network.js';
import { attachMockCdp } from './mock-cdp.js';

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-r02-origin-')));
  const root = path.join(base,'workspace');
  await mkdir(root);
  const hits = { crossTabMutation: 0, sameOriginPixel: 0, originAPixel: 0, originC: 0 };
  let urlA, urlB, urlC;
  const servers = [];
  async function start(handler) {
    const server = createServer(handler);
    servers.push(server);
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    return 'http://127.0.0.1:'+server.address().port;
  }
  urlC = await start((req,res) => {
    hits.originC++;
    res.setHeader('Content-Type','text/html');
    res.end('<title>Origin C</title><h1>Origin C page</h1>');
  });
  urlA = await start((req,res) => {
    if(req.url==='/pixel') {hits.originAPixel++;res.writeHead(200,{'Content-Type':'image/gif'});res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64'));return;}
    if(req.url==='/redirect') {res.writeHead(302,{Location:urlC+'/unapproved'});res.end();return;}
    res.setHeader('Content-Type','text/html');
    res.end('<title>Origin A</title><h1>Origin A page</h1>'+
      '<button id="popup" onclick="window.open(\''+urlC+'/popup\',\'_blank\')">Popup</button>'+
      '<script>setTimeout(()=>{new Image().src="'+urlB+'/unsafe-get"},1000)</script>');
  });
  urlB = await start((req,res) => {
    if(req.url==='/unsafe-get') {hits.crossTabMutation++;res.end('changed');return;}
    if(req.url?.startsWith('/pixel')) {hits.sameOriginPixel++;res.writeHead(200,{'Content-Type':'image/gif'});res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64'));return;}
    res.setHeader('Content-Type','text/html');
    const crossImage = req.url==='/leak-a' ? '<img src="'+urlA+'/pixel">' : '';
    res.end('<title>Origin B</title><h1>Origin B page</h1>'+
      '<img src="/pixel?x='+Math.random()+'">'+
      (req.url==='/leak-a'?'<img src="'+urlA+'/pixel">':''));
  });
  const runtime = createRuntime({root,namespace:'local',instanceId:'inst_r02',principalId:'principal_r02',
    browserOptions:{homeDirectory:path.join(base,'browser')},interactive:false,
    policy:normalizePolicy({categories:{browserNavigate:'allow',browserRead:'allow',browserInteract:'allow',browserSensitive:'deny'}})});
  t.after(async()=>{
    await runtime.stop().catch(()=>undefined);
    for(const server of servers){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
    await rm(base,{recursive:true,force:true});
  });
  return {runtime,urlA,urlB,urlC,hits};
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('R02 Chromium: navigating tab B to B must not let delayed image GET from untrusted tab A reach B', {timeout:60000}, async t=>{
  if(!existsSync(chromium.executablePath()))return t.skip('Chromium unavailable');
  const f=await fixture(t);
  const a=await f.runtime.dispatch('browser_open',{url:f.urlA+'/'});
  const tabB=await f.runtime.dispatch('browser_tabs',{sessionId:a.sessionId,action:'new'});
  const nav=await f.runtime.dispatch('browser_navigate',{sessionId:a.sessionId,tabId:tabB.activeTabId,url:f.urlB+'/'});
  assert.equal(nav.title,'Origin B');
  await delay(1300);
  assert.equal(f.hits.crossTabMutation,0,'Origin B must never inherit authorization for tab A');
  assert.ok(f.hits.sameOriginPixel>=1,'Tab B can still fetch its own authorized resources');
  const tabs=await f.runtime.dispatch('browser_tabs',{sessionId:a.sessionId});
  assert.equal(tabs.tabs.length,2);
});

test('R02 Chromium: later explicit same-tab navigation replaces old allowed origin; same-origin resources work', {timeout:60000},async t=>{
  if(!existsSync(chromium.executablePath()))return t.skip('Chromium unavailable');
  const f=await fixture(t);
  const a=await f.runtime.dispatch('browser_open',{url:f.urlA+'/'});
  await f.runtime.dispatch('browser_navigate',{sessionId:a.sessionId,url:f.urlB+'/leak-a'});
  await delay(250);
  assert.ok(f.hits.sameOriginPixel>=1);
  assert.equal(f.hits.originAPixel,0,'Previous origin must not stay authorized in this tab after navigation');
  const snapshot=await f.runtime.dispatch('browser_snapshot',{sessionId:a.sessionId});
  assert.match(snapshot.title,/Origin B/);
});

test('R02 Chromium: tab B explicit C approval does not authorize A redirect, popup, or C request', {timeout:60000},async t=>{
  if(!existsSync(chromium.executablePath()))return t.skip('Chromium unavailable');
  const f=await fixture(t);
  const a=await f.runtime.dispatch('browser_open',{url:f.urlA+'/'});
  const other=await f.runtime.dispatch('browser_tabs',{sessionId:a.sessionId,action:'new'});
  await f.runtime.dispatch('browser_navigate',{sessionId:a.sessionId,tabId:other.activeTabId,url:f.urlC+'/'});
  assert.equal(f.hits.originC,1);
  const tabA=other.tabs.find(x=>x.tabId!==other.activeTabId).tabId;
  await assert.rejects(f.runtime.dispatch('browser_navigate',{sessionId:a.sessionId,tabId:tabA,url:f.urlA+'/redirect'}),{code:'BROWSER_NAVIGATION_FAILED'});
  // A rejected redirect may leave Chromium's tab on an error document.
  // Test popup containment from a fresh explicitly authorized A tab.
  const newA=await f.runtime.dispatch('browser_tabs',{sessionId:a.sessionId,action:'new'});
  await f.runtime.dispatch('browser_navigate',{sessionId:a.sessionId,tabId:newA.activeTabId,url:f.urlA+'/'});
  await f.runtime.dispatch('browser_click',{sessionId:a.sessionId,tabId:newA.activeTabId,target:{selector:'#popup'}});
  await delay(200);
  assert.equal(f.hits.originC,1,'Neither redirect nor popup inherits tab B approval for origin C');
  const tabs=await f.runtime.dispatch('browser_tabs',{sessionId:a.sessionId});
  assert.equal(tabs.tabs.length,3,'Popups must not create another authorized tab');
});

test('R02 guard: requests with no known frame, other tab, or unapproved origin fail closed',async()=>{
  const pageA={on(){},url:()=> 'http://127.0.0.1:32120/a'},pageB={on(){},url:()=> 'http://127.0.0.1:32121/b'};
  let listener;
  const context={async route(_pattern,callback){listener=callback;},on(){},off(){},async routeWebSocket(){}};
  const cdp=attachMockCdp(context);
  const guard=await guardBrowserContext(context);
  try{
    await guard.allowNavigation('http://127.0.0.1:32120/a',pageA);
    await guard.allowNavigation('http://127.0.0.1:32121/b',pageB);
    assert.equal(guard.isAllowed('http://127.0.0.1:32120/x',pageA),true);
    assert.equal(guard.isAllowed('http://127.0.0.1:32121/x',pageA),false);
    assert.equal(guard.isAllowed('http://127.0.0.1:32121/x',pageB),true);
    assert.equal(guard.allowedOriginCount,2);
    let route,called;
    function mock(page,url,hasFrame=true) {
      called=[];
      route={request:()=>({
        url:()=>url,method:()=> 'GET',resourceType:()=> 'image',
        frame:()=>{if(!hasFrame)throw Error('no frame');return{page:()=>page};},
        isNavigationRequest:()=>false
      }),async fetch(){called.push('fetch');return{status:()=>200,headers:()=>({})};},
      async fulfill(){called.push('fulfill');},async abort(){called.push('abort');}};
      return route;
    }
    await listener(mock(pageA,'http://127.0.0.1:32121/pixel'));
    assert.deepEqual(called,['abort']);
    await listener(mock(null,'http://127.0.0.1:32120/pixel',false));
    assert.deepEqual(called,['abort']);
    await listener(mock(pageB,'http://127.0.0.1:32121/pixel'));
    assert.deepEqual(called,['abort'], 'pending navigation cannot authorize subresource requests');
    const mainFrame={page:()=>pageB};
    pageB.mainFrame=()=>mainFrame;
    const mainRequest={
      url:()=> 'http://127.0.0.1:32121/b',method:()=> 'GET',
      resourceType:()=> 'document',frame:()=>mainFrame,
      isNavigationRequest:()=>true,redirectedFrom:()=>null
    };
    await listener({
      request:()=>mainRequest,
      async fetch(){return {status:()=>200,headers:()=>({})}},
      async fulfill(){},async abort(){throw Error('Fixture main document denied')}
    });
    cdp.commitMainDocument(pageB,'http://127.0.0.1:32121/b');
    assert.equal(guard.confirmNavigation(pageB,'http://127.0.0.1:32121/b',
      {request:()=>mainRequest}), true);
    await listener(mock(pageB,'http://127.0.0.1:32121/pixel'));
    assert.deepEqual(called,['fetch','fulfill'], 'confirmed navigation allows same-origin subresources');
  }finally{guard.close();}
});

test('R02 DNS: protected addresses and unapproved redirects still fail before any network IO',async()=>{
  await assert.rejects(authorizeBrowserUrl('https://safe.example.test/',{
    resolve:async()=>[{address:'169.254.169.254',family:4}]
  }),{code:'BROWSER_URL_DENIED'});
  const requests=[];
  const page={on(){}};
  let listener;
  const ctx={async route(_pattern,callback){listener=callback;},on(){},off(){},async routeWebSocket(){}};
  attachMockCdp(ctx);
  const guard=await guardBrowserContext(ctx);
  try{
    const url='http://127.0.0.1:32120/redirect';
    const frame={page:()=>page};
    page.mainFrame=()=>frame;
    await guard.allowNavigation(url,page);
    const route={
      request:()=>({url:()=> 'http://127.0.0.1:32120/redirect',
        method:()=> 'GET',resourceType:()=> 'document',frame:()=>frame,
        isNavigationRequest:()=>true,redirectedFrom:()=>null}),
      async fetch(){requests.push('fetch');return{status:()=>302,headers:()=>({location:'http://127.0.0.1:32121/unsafe'})};},
      async fulfill(){requests.push('fulfill');},async abort(){requests.push('abort');}
    };
    await listener(route);
    assert.deepEqual(requests,['fetch','abort']);
  }finally{guard.close();}
});
