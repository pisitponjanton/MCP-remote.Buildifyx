import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { captureConfiguredPage } from '../../src/browser/device-capture.js';
import { createRuntime } from '../../src/core/runtime.js';
import { normalizePolicy } from '../../src/permissions/policy.js';
import { parseMcpToolInput, createToolManifest } from '../../src/transport/mcp/tools/registry.js';

const sharp = createRequire(import.meta.url)('sharp');

const sessionId = 'browser_12345678-1234-1234-1234-123456789abc';
const content = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<style>body{margin:0;min-height:1400px}' +
  '#responsive{width:100vw;height:200px;background:#ff0000}' +
  '@media(max-width:600px){#responsive{background:#0000ff}}' +
  '#resolution{width:100px;height:100px;background:#ff0000}' +
  '@media(min-resolution:2dppx){#resolution{background:#008000}}</style></head>' +
  '<body><div id="responsive"></div><div id="resolution"></div></body></html>';

async function fixture(t, categories = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(),'bdxa-f05-')));
  const root = path.join(base,'workspace');
  await mkdir(root);
  const http = createServer((_,res)=>{
    res.setHeader('Content-Type','text/html');
    res.end(content);
  });
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  const runtime = createRuntime({root,namespace:'local',instanceId:'inst_f05',principalId:'principal_f05',
    browserOptions:{homeDirectory:path.join(base,'home')},
    policy:normalizePolicy({categories:{
      browserNavigate:'allow',browserRead:'allow',browserCapture:'allow',imageRead:'allow',cacheManage:'allow',...categories
    }}),interactive:false});
  t.after(async()=>{
    await runtime.stop().catch(()=>undefined);
    await new Promise(resolve=>http.close(resolve));
    await rm(base,{recursive:true,force:true});
  });
  return {runtime,url:'http://127.0.0.1:'+http.address().port+'/'};
}
async function capture(runtime,sessionId,options={}) {
  const meta=await runtime.dispatch('browser_screenshot',{sessionId,...options});
  const image=await runtime.services.__readImageBytes(meta.artifactId,{screenshotApproved:true});
  const data=await sharp(image.data).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  return {meta,data};
}
function pixel(image,x,y) {
  const {data,info}=image.data;
  const start=(y*info.width+x)*info.channels;
  return [...data.subarray(start,start+3)];
}

test('F05: schema exposes bounded DPR and mobile/desktop/custom viewport without changing existing defaults',()=>{
  const a=parseMcpToolInput('browser_screenshot',{sessionId});
  assert.equal(a.scale,'css');
  assert.equal(a.viewportPreset,undefined);
  assert.equal(a.deviceScaleFactor,undefined);
  const custom=parseMcpToolInput('browser_screenshot',{sessionId,viewportPreset:'desktop',deviceScaleFactor:1.5,scale:'device'});
  assert.equal(custom.deviceScaleFactor,1.5);
  assert.equal(custom.viewportPreset,'desktop');
  const tools=createToolManifest();
  const schema=tools.tools.find(x=>x.name==='browser_screenshot')?.inputSchema;
  assert.ok(schema?.properties?.deviceScaleFactor,'Cloud/Local advertised schema must include DPR');
  for(const options of [
    {deviceScaleFactor:0}, {deviceScaleFactor:4}, {deviceScaleFactor:'2'},
    {viewportPreset:'mobile',viewport:{width:390,height:844}},
    {viewport:{width:239,height:900}},
    {mode:'element',target:{selector:'#responsive'},deviceScaleFactor:2},
    {viewportPreset:'tablet'}
  ]) assert.throws(()=>parseMcpToolInput('browser_screenshot',{sessionId,...options}),{code:'INVALID_INPUT'});
});

test('F05: real Chromium mobile layout and DPR2 produces native-resolution PNG; CSS scale and viewport restore work', {timeout:60000},async t=>{
  if(!existsSync(chromium.executablePath()))return t.skip('Chromium missing');
  const f=await fixture(t);
  const opened=await f.runtime.dispatch('browser_open',{url:f.url});
  const before=await capture(f.runtime,opened.sessionId);
  const mobile=await capture(f.runtime,opened.sessionId,{viewportPreset:'mobile',deviceScaleFactor:2,scale:'device'});
  assert.deepEqual(mobile.meta.captureViewport,{width:390,height:844});
  assert.equal(mobile.meta.mobileLayout,true);
  assert.equal(mobile.meta.deviceScaleFactor,2);
  assert.equal(mobile.meta.width,780);
  assert.equal(mobile.meta.height,1688);
  assert.deepEqual(pixel(mobile,40,40),[0,0,255],'Mobile media query must render blue');
  assert.deepEqual(pixel(mobile,40,440),[0,128,0],'DPR media query must render green');
  const mobileCss=await capture(f.runtime,opened.sessionId,{viewportPreset:'mobile',deviceScaleFactor:2,scale:'css'});
  assert.equal(mobileCss.meta.width,390);
  assert.equal(mobileCss.meta.height,844);
  assert.deepEqual(pixel(mobileCss,20,20),[0,0,255]);
  const restored=await capture(f.runtime,opened.sessionId);
  assert.equal(restored.meta.width,before.meta.width);
  assert.equal(restored.meta.height,before.meta.height);
  assert.deepEqual(pixel(restored,20,20),[255,0,0],'Original desktop layout is restored');
});

test('F05: desktop/custom capture supports DPR1.5, JPEG, bounded full-page and no layout leakage', {timeout:60000},async t=>{
  if(!existsSync(chromium.executablePath()))return t.skip('Chromium missing');
  const f=await fixture(t);
  const opened=await f.runtime.dispatch('browser_open',{url:f.url});
  const baseline=await capture(f.runtime,opened.sessionId);
  const desktop=await capture(f.runtime,opened.sessionId,{viewportPreset:'desktop',deviceScaleFactor:1,scale:'device'});
  assert.equal(desktop.meta.width,1440);
  assert.equal(desktop.meta.height,900);
  assert.deepEqual(pixel(desktop,20,20),[255,0,0]);
  const custom=await capture(f.runtime,opened.sessionId,{
    viewport:{width:600,height:420},deviceScaleFactor:1.5,scale:'device',format:'jpeg'
  });
  assert.equal(custom.meta.mimeType,'image/jpeg');
  assert.equal(custom.meta.width,900);
  assert.equal(custom.meta.height,630);
  const full=await capture(f.runtime,opened.sessionId,{
    mode:'fullPage',viewport:{width:600,height:420},deviceScaleFactor:2,scale:'css'
  });
  assert.equal(full.meta.width,600);
  assert.ok(full.meta.height>=1400,'Full-page capture must include scrollable area');
  assert.ok(full.meta.height<=8192);
  const restored=await capture(f.runtime,opened.sessionId);
  assert.equal(restored.meta.width,baseline.meta.width);
  assert.equal(restored.meta.height,baseline.meta.height);
});

test('F05: excessive DPR pixel budget and capture permission deny are fail-closed, leave viewport intact', {timeout:60000},async t=>{
  if(!existsSync(chromium.executablePath()))return t.skip('Chromium missing');
  const f=await fixture(t);
  const opened=await f.runtime.dispatch('browser_open',{url:f.url});
  const baseline=await capture(f.runtime,opened.sessionId);
  await assert.rejects(f.runtime.dispatch('browser_screenshot',{
    sessionId:opened.sessionId,viewport:{width:4096,height:4096},deviceScaleFactor:3,scale:'device'
  }),{code:'BROWSER_SCREENSHOT_LIMIT'});
  const after=await capture(f.runtime,opened.sessionId);
  assert.equal(after.meta.width,baseline.meta.width);
  assert.equal(after.meta.height,baseline.meta.height);
  await f.runtime.policyManager.setCategory('browserCapture','deny');
  await assert.rejects(f.runtime.dispatch('browser_screenshot',{
    sessionId:opened.sessionId,viewportPreset:'mobile',deviceScaleFactor:3,scale:'device'
  }),{code:'PERMISSION_DENIED'});
});


test('F05: CDP capture failure clears temporary emulation and restores original viewport without saving',async()=>{
  const original={width:1280,height:720};
  let current={...original};
  const events=[];
  const protocol={
    async send(method){
      events.push(method);
      if(method==='Page.captureScreenshot')throw new Error('simulated CDP failure');
      return {};
    },
    async detach(){events.push('detach');}
  };
  const page={
    viewportSize:()=>({...current}),
    setViewportSize:async next=>{current={...next};events.push('resize:'+next.width);},
    context:()=>({newCDPSession:async()=>protocol}),
    evaluate:async()=>({width:390,height:844})
  };
  await assert.rejects(captureConfiguredPage(page,{
    viewport:{width:390,height:844},deviceScaleFactor:2,mobile:true,scale:'device'
  }),/simulated CDP failure/);
  assert.deepEqual(current,original);
  assert.deepEqual(events,[
    'resize:390','Emulation.setDeviceMetricsOverride','Page.captureScreenshot',
    'Emulation.clearDeviceMetricsOverride','detach','resize:1280'
  ]);
});
