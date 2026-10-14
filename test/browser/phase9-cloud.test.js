import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { createRuntime } from '../../src/core/runtime.js';
import { createArtifactCache } from '../../src/cache/store.js';
import { createCloudAgent } from '../../src/transport/cloud.js';
import { createToolManifest } from '../../src/transport/mcp/tools/registry.js';
import { normalizePolicy } from '../../src/permissions/policy.js';
import { MEDIA_CHUNK_BYTES } from '../../src/transport/media/protocol.js';

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(),'bdxa-phase9-cloud-')));
  const root = path.join(base,'project');
  await mkdir(root);
  const http = createServer((_req,res)=>{
    res.setHeader('Content-Type','text/html');
    res.end('<title>Cloud Phase9</title><main>Cloud image integration</main><div style="height:600px;background:#124578">Ready</div>');
  });
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  const pageUrl = 'http://127.0.0.1:' + http.address().port + '/';
  const ws = new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise(resolve=>ws.once('listening',resolve));
  const cache = createArtifactCache({workspaceRoot:root,namespace:'cloud',homeDirectory:path.join(base,'state')});
  const policy = normalizePolicy({categories:{
    browserNavigate:'allow',browserRead:'allow',browserCapture:'allow',browserDiagnostics:'allow',
    imageRead:'allow',imageSave:'allow',cacheManage:'allow',browserExternal:'deny'
  }});
  const runtime = createRuntime({root,namespace:'cloud',instanceId:'inst_p9_cloud',
    principalId:'cloud_device_p9',imageCache:cache,policy,interactive:false,
    browserOptions:{homeDirectory:path.join(base,'state')}});
  let socket;
  const frames = [];
  ws.on('connection',(s,req)=>{
    socket=s;
    assert.equal(req.headers.authorization,'Bearer phase9-device-token');
    s.on('message',buf=>frames.push(JSON.parse(buf.toString())));
  });
  const agent = createCloudAgent({cloudUrl:'http://127.0.0.1:' + ws.address().port,
    credentials:{deviceId:'device-phase9',deviceToken:'phase9-device-token'},
    runtime,manifest:createToolManifest(),version:'0.3.3',
    instance:{instanceId:'inst_p9_cloud',name:'workspace',path:root,mode:'foreground'},
    deviceInfo:{},eventBus:{emit:()=>{}},heartbeatMs:60000,reconnect:false});
  t.after(async()=>{
    await agent.stop().catch(()=>undefined);
    await runtime.stop().catch(()=>undefined);
    cache.close();
    for(const c of ws.clients)c.terminate();
    await new Promise(resolve=>ws.close(resolve));
    await new Promise(resolve=>http.close(resolve));
    await rm(base,{recursive:true,force:true});
  });
  function send(message) {
    assert.equal(socket?.readyState,1,'Cloud mock must be connected');
    socket.send(JSON.stringify(message));
  }
  async function waitFor(predicate, timeoutMs=10000) {
    const until=Date.now()+timeoutMs;
    while(Date.now()<until){
      const match=frames.find(predicate);
      if(match)return match;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error('Timed out awaiting Cloud mock frame: '+JSON.stringify(frames.slice(-3)));
  }
  agent.connect();
  const ready=await waitFor(m=>m.type==='device.ready');
  return {root,base,cache,runtime,agent,frames,ready,pageUrl,send,waitFor,ws};
}

test('Phase 9 Cloud integration: authenticated instance routing, screenshot MIME, chunk ACKs, checksum, and browser close', {timeout:60000},async t=>{
  if(!existsSync(chromium.executablePath()))return t.skip('Chromium binary missing');
  const f=await fixture(t);
  assert.equal(f.ready.protocolVersion,2);
  assert.ok(f.ready.toolManifest.names.includes('browser_screenshot'));
  f.send({type:'tool.call',requestId:'wrong-instance',instanceId:'inst_other',
    tool:'browser_open',arguments:{url:f.pageUrl}});
  const denied=await f.waitFor(m=>m.type==='tool.error'&&m.requestId==='wrong-instance');
  assert.equal(denied.error.code,'INSTANCE_MISMATCH');
  f.send({type:'media.capabilities.accept',instanceId:'inst_p9_cloud',version:1,
    features:['image-content','transfer-chunks-v1'],maxChunkBytes:MEDIA_CHUNK_BYTES});
  f.send({type:'tool.call',requestId:'p9-open',instanceId:'inst_p9_cloud',
    tool:'browser_open',arguments:{url:f.pageUrl}});
  const opened=await f.waitFor(m=>m.type==='tool.result'&&m.requestId==='p9-open');
  assert.equal(opened.result.title,'Cloud Phase9');
  f.send({type:'tool.call',requestId:'p9-screenshot',instanceId:'inst_p9_cloud',
    tool:'browser_screenshot',arguments:{sessionId:opened.result.sessionId}});
  const offer=await f.waitFor(m=>m.type==='media.transfer.open'&&m.requestId==='p9-screenshot');
  assert.equal(offer.mimeType,'image/png');
  assert.ok(offer.size>100);
  f.send({type:'media.transfer.accept',instanceId:'inst_p9_cloud',
    transferId:offer.transferId,requestId:offer.requestId,accepted:true});
  let offset=0,bytes=Buffer.alloc(0);
  for(let index=0;offset<offer.size;index++){
    const frame=await f.waitFor(m=>m.type==='media.transfer.chunk'&&m.transferId===offer.transferId&&m.index===index);
    assert.ok(Buffer.byteLength(JSON.stringify(frame))<4*1024*1024);
    const chunk=Buffer.from(frame.data,'base64');
    assert.equal(chunk.length,frame.length);
    bytes=Buffer.concat([bytes,chunk]);
    offset+=chunk.length;
    f.send({type:'media.transfer.ack',instanceId:'inst_p9_cloud',transferId:offer.transferId,
      requestId:offer.requestId,index,offset});
  }
  const complete=await f.waitFor(m=>m.type==='media.transfer.complete'&&m.transferId===offer.transferId);
  assert.equal(complete.sha256,createHash('sha256').update(bytes).digest('hex'));
  f.send({type:'media.transfer.received',instanceId:'inst_p9_cloud',
    transferId:offer.transferId,requestId:offer.requestId,size:bytes.length,sha256:complete.sha256});
  const delivered=await f.waitFor(m=>m.type==='tool.result'&&m.requestId==='p9-screenshot');
  assert.equal(delivered.result.mediaTransfer.version,1);
  assert.equal(delivered.result.imageBytesDelivered,false);
  assert.equal(delivered.result.sha256,complete.sha256);
  assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.deepEqual((await f.cache.get(delivered.result.artifactId)).data,bytes);
  f.send({type:'tool.call',requestId:'p9-close',instanceId:'inst_p9_cloud',
    tool:'browser_close',arguments:{sessionId:opened.result.sessionId}});
  assert.equal((await f.waitFor(m=>m.type==='tool.result'&&m.requestId==='p9-close')).result.closed,true);
});

test('Phase 9 Cloud integration: screenshot media revocation aborts acknowledged transfer and does not deliver final image', {timeout:60000},async t=>{
  if(!existsSync(chromium.executablePath()))return t.skip('Chromium binary missing');
  const f=await fixture(t);
  f.send({type:'media.capabilities.accept',instanceId:'inst_p9_cloud',version:1,
    features:['image-content','transfer-chunks-v1'],maxChunkBytes:MEDIA_CHUNK_BYTES});
  f.send({type:'tool.call',requestId:'r-open',instanceId:'inst_p9_cloud',
    tool:'browser_open',arguments:{url:f.pageUrl}});
  const opened=await f.waitFor(m=>m.type==='tool.result'&&m.requestId==='r-open');
  f.send({type:'tool.call',requestId:'r-shot',instanceId:'inst_p9_cloud',
    tool:'browser_screenshot',arguments:{sessionId:opened.result.sessionId}});
  const offer=await f.waitFor(m=>m.type==='media.transfer.open'&&m.requestId==='r-shot');
  await f.runtime.policyManager.setCategory('browserCapture','deny');
  f.send({type:'media.transfer.accept',instanceId:'inst_p9_cloud',transferId:offer.transferId,requestId:offer.requestId,accepted:true});
  const error=await f.waitFor(m=>m.type==='tool.error'&&m.requestId==='r-shot');
  assert.equal(error.error.code,'MEDIA_DENIED');
  assert.equal(f.frames.some(m=>m.type==='tool.result'&&m.requestId==='r-shot'),false);
  assert.ok(f.frames.some(m=>m.type==='media.transfer.cancel'&&m.requestId==='r-shot'));
});


test('Phase 9 Cloud integration: disconnect clears live browser sessions, reconnect keeps same identity and protocol', {timeout:60000},async t=>{
  if(!existsSync(chromium.executablePath()))return t.skip('Chromium binary missing');
  const f=await fixture(t);
  f.send({type:'tool.call',requestId:'before-drop',instanceId:'inst_p9_cloud',
    tool:'browser_open',arguments:{url:f.pageUrl}});
  const first=await f.waitFor(m=>m.type==='tool.result'&&m.requestId==='before-drop');
  assert.match(first.result.sessionId,/^browser_/);
  const active=[...f.ws.clients][0];
  active.terminate();
  const deadline=Date.now()+5000;
  while(f.agent.getState().status!=='disconnected'&&Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(f.agent.getState().status,'disconnected');
  let removed=false;
  for(let n=0;n<150;n++){
    try { await f.runtime.dispatch('browser_snapshot',{sessionId:first.result.sessionId}); }
    catch(error){ if(error.code==='BROWSER_SESSION_NOT_FOUND'){removed=true;break;} }
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(removed,true,'Cloud disconnect should release temporary browser session');
  f.agent.connect();
  await f.waitFor(m=>m.type==='device.ready'&&f.frames.filter(x=>x.type==='device.ready').length>=2);
  const ready=f.frames.filter(m=>m.type==='device.ready');
  assert.equal(ready.length,2);
  assert.equal(ready[0].deviceId,ready[1].deviceId);
  assert.equal(ready[0].instanceId,ready[1].instanceId);
  assert.equal(ready[1].protocolVersion,2);
  f.send({type:'tool.call',requestId:'after-reconnect',instanceId:'inst_p9_cloud',
    tool:'browser_open',arguments:{url:f.pageUrl}});
  const second=await f.waitFor(m=>m.type==='tool.result'&&m.requestId==='after-reconnect');
  assert.notEqual(first.result.sessionId,second.result.sessionId);
  f.send({type:'tool.call',requestId:'close-after',instanceId:'inst_p9_cloud',
    tool:'browser_close',arguments:{sessionId:second.result.sessionId}});
  const end=await f.waitFor(m=>m.type==='tool.result'&&m.requestId==='close-after');
  assert.equal(end.result.closed,true);
});


test('Phase 9 legacy Cloud compatibility: old text tools remain available and no unsolicited binary transfer occurs', {timeout:60000},async t=>{
  if(!existsSync(chromium.executablePath()))return t.skip('Chromium binary missing');
  const f=await fixture(t);
  await writeFile(path.join(f.root,'legacy.txt'),'Old Cloud tool contract stays intact.');
  f.send({type:'tool.call',requestId:'legacy-read',instanceId:'inst_p9_cloud',
    tool:'read_file',arguments:{path:'legacy.txt'}});
  const textResult=await f.waitFor(m=>m.type==='tool.result'&&m.requestId==='legacy-read');
  assert.equal(textResult.result.content,'Old Cloud tool contract stays intact.');
  f.send({type:'tool.call',requestId:'legacy-browser-open',instanceId:'inst_p9_cloud',
    tool:'browser_open',arguments:{url:f.pageUrl}});
  const opened=await f.waitFor(m=>m.type==='tool.result'&&m.requestId==='legacy-browser-open');
  f.send({type:'tool.call',requestId:'legacy-capture',instanceId:'inst_p9_cloud',
    tool:'browser_screenshot',arguments:{sessionId:opened.result.sessionId}});
  const capture=await f.waitFor(m=>m.type==='tool.result'&&m.requestId==='legacy-capture');
  assert.match(capture.result.artifactId,/^art_/);
  assert.equal(capture.result.imageBytesDelivered,false);
  assert.equal(capture.result.mediaTransfer,undefined);
  assert.equal(f.frames.filter(m=>m.type.startsWith('media.transfer')).length,0);
  f.send({type:'tool.call',requestId:'legacy-close',instanceId:'inst_p9_cloud',
    tool:'browser_close',arguments:{sessionId:opened.result.sessionId}});
  assert.equal((await f.waitFor(m=>m.type==='tool.result'&&m.requestId==='legacy-close')).result.closed,true);
});


test('Phase 9 Cloud integration: disconnect cancels an in-flight browser open before it can create a session', {timeout:60000},async t=>{
  const f=await fixture(t);
  const original=f.runtime.services.browser_open;
  let letContinue;
  const gate=new Promise(resolve=>{letContinue=resolve;});
  let notifyStarted;
  const started=new Promise(resolve=>{notifyStarted=resolve;});
  let operationError;
  f.runtime.services.browser_open=async(input,context)=>{
    notifyStarted();
    await gate;
    try {return await original(input,context);}
    catch(error){operationError=error;throw error;}
  };
  f.send({type:'tool.call',requestId:'cancel-during-launch',instanceId:'inst_p9_cloud',
    tool:'browser_open',arguments:{url:f.pageUrl}});
  await started;
  for(const ws of f.ws.clients)ws.terminate();
  const deadline=Date.now()+5000;
  while(f.agent.getState().status!=='disconnected'&&Date.now()<deadline)
    await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.agent.getState().status,'disconnected');
  f.agent.connect();
  await f.waitFor(m=>m.type==='device.ready'&&f.frames.filter(x=>x.type==='device.ready').length>=2);
  letContinue();
  for(let i=0;i<100&&!operationError;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(operationError?.code,'REQUEST_CANCELLED');
  assert.equal(f.runtime.services.active,0,'No late browser session may be created after socket disconnect');
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(f.frames.some(m=>m.requestId==='cancel-during-launch'&&['tool.result','tool.error'].includes(m.type)),false,
    'Stale request result must not cross into newly connected Cloud socket');
});
