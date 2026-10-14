import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { createRuntime } from '../../src/core/runtime.js';
import { normalizePolicy } from '../../src/permissions/policy.js';
import { createArtifactCache } from '../../src/cache/store.js';
import { parseMcpToolInput } from '../../src/transport/mcp/tools/registry.js';

async function fixture(t, categories = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-visual-')));
  const root = path.join(base, 'workspace');
  const home = path.join(base, 'state');
  await mkdir(root);
  const http = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url?.startsWith('/missing')) { res.writeHead(503); return res.end('unavailable'); }
    res.end('<title>Visual fixture</title><style>body{margin:0}.visual{background:#445566;height:380px;width:380px}body{min-height:1500px}</style>' +
      '<div class="visual" id="panel">Before</div>' +
      '<button id="change" onclick="document.getElementById(' + "'panel'" + ').style.background=' + "'#f00'" + ';">Change</button>' +
      '<button id="diagnose" onclick="console.error(' + "'Bearer SECRET_VALUE'" + ');fetch(' + "'/missing?token=SECRET_VALUE'" + ');setTimeout(()=>{throw Error(' + "'password=SECRET_VALUE'" + ')},0);">Diagnose</button>');
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const cache = createArtifactCache({ workspaceRoot: root, homeDirectory: home, namespace: 'local' });
  const policy = normalizePolicy({ categories: { browserNavigate:'allow', browserRead:'allow', browserInteract:'allow',
    browserCapture:'allow', browserDiagnostics:'allow', imageRead:'allow', imageSave:'allow', cacheManage:'allow', ...categories } });
  const runtime = createRuntime({ root, namespace:'local', instanceId:'inst_visual_test', principalId:'principal_visual_test',
    browserOptions:{ homeDirectory: home }, imageCache: cache, policy, interactive:false });
  t.after(async()=>{ await runtime.stop().catch(()=>undefined); cache.close(); await new Promise(resolve=>http.close(resolve)); await rm(base,{recursive:true,force:true}); });
  return { runtime, root, base, home, cache, url:'http://127.0.0.1:'+http.address().port+'/' };
}

test('browser screenshot and diagnostics input schemas enforce bounds',()=>{
  const sessionId='browser_12345678-1234-1234-1234-123456789abc';
  assert.deepEqual(parseMcpToolInput('browser_diagnostics',{sessionId}),{sessionId,category:'all',limit:30,sinceId:0});
  assert.throws(()=>parseMcpToolInput('browser_screenshot',{sessionId,mode:'element'}),{code:'INVALID_INPUT'});
  assert.throws(()=>parseMcpToolInput('browser_screenshot',{sessionId,mode:'fullPage',format:'gif'}),{code:'INVALID_INPUT'});
  assert.throws(()=>parseMcpToolInput('browser_screenshot',{sessionId,compareToArtifactId:'../../escape'}),{code:'INVALID_INPUT'});
  assert.throws(()=>parseMcpToolInput('browser_diagnostics',{sessionId,limit:101}),{code:'INVALID_INPUT'});
  assert.equal(parseMcpToolInput('browser_screenshot',{sessionId,viewportPreset:'mobile'}).viewportPreset,'mobile');
  assert.equal(parseMcpToolInput('browser_screenshot',{sessionId,viewport:{width:390,height:844},scale:'device'}).scale,'device');
  assert.throws(()=>parseMcpToolInput('browser_screenshot',{sessionId,viewportPreset:'tablet'}),{code:'INVALID_INPUT'});
  assert.throws(()=>parseMcpToolInput('browser_screenshot',{sessionId,viewport:{width:5000,height:600}}),{code:'INVALID_INPUT'});
  assert.throws(()=>parseMcpToolInput('browser_screenshot',{sessionId,viewportPreset:'mobile',viewport:{width:390,height:844}}),{code:'INVALID_INPUT'});
  assert.throws(()=>parseMcpToolInput('browser_screenshot',{sessionId,mode:'element',target:{selector:'#panel'},viewportPreset:'mobile'}),{code:'INVALID_INPUT'});
});

test('capture and diagnostics require separate permission even when reading browser is allowed',async t=>{
  const f=await fixture(t,{browserCapture:'ask',browserDiagnostics:'ask'});
  const opened=await f.runtime.dispatch('browser_open',{url:f.url});
  await assert.rejects(f.runtime.dispatch('browser_screenshot',{sessionId:opened.sessionId}),{code:'CONFIRMATION_REQUIRED'});
  await assert.rejects(f.runtime.dispatch('browser_diagnostics',{sessionId:opened.sessionId}),{code:'CONFIRMATION_REQUIRED'});
  assert.deepEqual((await f.cache.list()).filter(x=>x.kind==='screenshot'),[]);
});

test('Chromium captures viewport/fullPage/element and compares before/after cached screenshots', {timeout:60000},async t=>{
  if(!existsSync(chromium.executablePath()))return t.skip('Chromium missing');
  const f=await fixture(t);
  const session=await f.runtime.dispatch('browser_open',{url:f.url});
  const options={sessionId:session.sessionId};
  const before=await f.runtime.dispatch('browser_screenshot',{...options,label:'before'});
  assert.equal(before.mode,'viewport');
  assert.equal(before.mimeType,'image/png');
  assert.equal(before.imageBytesDelivered,false);
  const cacheEntry=await f.cache.get(before.artifactId);
  assert.equal(cacheEntry.metadata.kind,'screenshot');
  assert.equal(cacheEntry.metadata.origin,'capture');
  assert.equal(cacheEntry.data.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const mobile=await f.runtime.dispatch('browser_screenshot',{...options,viewportPreset:'mobile'});
  assert.deepEqual(mobile.captureViewport,{width:390,height:844});
  assert.equal(mobile.width,390);
  assert.equal(mobile.height,844);
  assert.equal(mobile.scale,'css');
  const afterMobile=await f.runtime.dispatch('browser_screenshot',options);
  assert.equal(afterMobile.width,before.width,'original viewport is restored after mobile capture');
  assert.equal(afterMobile.height,before.height);
  const custom=await f.runtime.dispatch('browser_screenshot',{...options,viewport:{width:600,height:420},scale:'device'});
  assert.deepEqual(custom.captureViewport,{width:600,height:420});
  assert.equal(custom.width,600);
  assert.equal(custom.height,420);
  const desktop=await f.runtime.dispatch('browser_screenshot',{...options,viewportPreset:'desktop'});
  assert.equal(desktop.width,1440);
  assert.equal(desktop.height,900);
  const full=await f.runtime.dispatch('browser_screenshot',{...options,mode:'fullPage',format:'jpeg'});
  assert.equal(full.mimeType,'image/jpeg');
  assert.ok(full.height>before.height);
  const element=await f.runtime.dispatch('browser_screenshot',{...options,mode:'element',target:{selector:'#panel'},label:'element'});
  assert.ok(element.width<before.width&&element.height<before.height);
  await f.runtime.dispatch('browser_click',{...options,target:{selector:'#change'}});
  const after=await f.runtime.dispatch('browser_screenshot',{...options,label:'after',compareToArtifactId:before.artifactId});
  assert.equal(after.comparison.dimensionsMatch,true);
  assert.ok(after.comparison.changedPercent>0);
  assert.equal(after.comparison.beforeArtifactId,before.artifactId);
  const mismatched=await f.runtime.dispatch('browser_screenshot',{...options,compareToArtifactId:element.artifactId});
  assert.equal(mismatched.comparison.dimensionsMatch,false);
  assert.equal(mismatched.comparison.changedPercent,null);
  assert.equal((await f.runtime.dispatch('get_cached_image',{artifactId:before.artifactId})).sha256,before.sha256);
  assert.equal((await f.runtime.dispatch('save_cached_image',{artifactId:before.artifactId,destinationPath:'approved.png'})).saved,true);
  assert.deepEqual(await readFile(path.join(f.root,'approved.png')),cacheEntry.data);
  await f.runtime.dispatch('clear_cache',{});
  assert.deepEqual(await readFile(path.join(f.root,'approved.png')),cacheEntry.data);
  await assert.rejects(f.runtime.dispatch('get_cached_image',{artifactId:before.artifactId}));
});

test('diagnostics return console, pageerror, network failure without secret contents or query tokens', {timeout:60000},async t=>{
  if(!existsSync(chromium.executablePath()))return t.skip('Chromium missing');
  const f=await fixture(t,{browserSensitive:'allow'});
  const session=await f.runtime.dispatch('browser_open',{url:f.url});
  await f.runtime.dispatch('browser_click',{sessionId:session.sessionId,target:{selector:'#diagnose'}});
  let value;
  for(let i=0;i<70;i++){
    value=await f.runtime.dispatch('browser_diagnostics',{sessionId:session.sessionId,limit:100});
    if(['console','pageerror','network'].every(k=>value.events.some(e=>e.category===k)))break;
    await new Promise(resolve=>setTimeout(resolve,35));
  }
  assert.ok(value.events.some(e=>e.category==='console'));
  assert.ok(value.events.some(e=>e.category==='pageerror'));
  assert.ok(value.events.some(e=>e.category==='network'&&e.outcome==='failed'),
    'Unapproved script GET must be blocked before it reaches the HTTP server');
  assert.equal(value.events.some(e=>e.category==='network'&&e.status===503),false);
  // Explicit approval is still able to exercise the HTTP 503 diagnostics path.
  await f.runtime.dispatch('browser_click',{
    sessionId:session.sessionId,target:{selector:'#diagnose'},confirmSensitive:true
  });
  for(let i=0;i<70;i++){
    value=await f.runtime.dispatch('browser_diagnostics',{sessionId:session.sessionId,limit:100});
    if(value.events.some(e=>e.category==='network'&&e.status===503))break;
    await new Promise(resolve=>setTimeout(resolve,35));
  }
  assert.ok(value.events.some(e=>e.category==='network'&&e.status===503));
  assert.equal(value.redacted,true);
  assert.doesNotMatch(JSON.stringify(value),/SECRET_VALUE|password=|token=|Bearer/);
  assert.ok(value.events.every(e=>e.redacted===true));
  const next=await f.runtime.dispatch('browser_diagnostics',{sessionId:session.sessionId,sinceId:value.nextSinceId});
  assert.equal(next.events.length,0);
  const network=await f.runtime.dispatch('browser_diagnostics',{sessionId:session.sessionId,category:'network'});
  assert.ok(network.events.every(e=>e.category==='network'));
});

test('workspace ownership blocks comparing a screenshot from a different workspace', {timeout:60000},async t=>{
  if(!existsSync(chromium.executablePath()))return t.skip('Chromium missing');
  const f=await fixture(t);
  const other=await realpath(await mkdtemp(path.join(os.tmpdir(),'bdxa-visual-other-')));
  t.after(()=>rm(other,{recursive:true,force:true}));
  const otherCache=createArtifactCache({workspaceRoot:other,homeDirectory:f.home,namespace:'local'});
  const alien=await otherCache.put({data:Buffer.from('private-other'),mimeType:'image/png',kind:'screenshot',origin:'capture'});
  const session=await f.runtime.dispatch('browser_open',{url:f.url});
  await assert.rejects(f.runtime.dispatch('browser_screenshot',{sessionId:session.sessionId,compareToArtifactId:alien.id}),
    e=>e.code==='CACHE_NOT_FOUND', 'Foreign-workspace artifacts remain invisible and now preserve the precise cache code');
  otherCache.close();
});
