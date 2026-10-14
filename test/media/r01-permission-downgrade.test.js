import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createRuntime } from '../../src/core/runtime.js';
import { normalizePolicy } from '../../src/permissions/policy.js';
import { createArtifactCache } from '../../src/cache/store.js';
import { createMediaTransferPermission } from '../../src/transport/media/access-policy.js';
import { createLocalMediaAgent } from '../../src/transport/media/local-agent.js';
import { createCloudMediaBridge } from '../../src/transport/media/cloud-bridge.js';
import { MEDIA_CHUNK_BYTES } from '../../src/transport/media/protocol.js';

const sharp = createRequire(import.meta.url)('sharp');

const secret='c'.repeat(64);
async function fixture(t){
  const base=await mkdtemp(path.join(os.tmpdir(),'bdxa-r01-'));
  const root=path.join(base,'workspace');
  await mkdir(root);
  const cache=createArtifactCache({workspaceRoot:root,namespace:'local',homeDirectory:path.join(base,'private')});
  const runtime=createRuntime({root,namespace:'local',instanceId:'inst_r01',principalId:'principal_r01',
    imageCache:cache,interactive:false,policy:normalizePolicy({categories:{
      imageRead:'allow',imageSave:'allow',cacheManage:'allow',browserCapture:'allow'
    }})});
  t.after(async()=>{await runtime.stop().catch(()=>undefined);cache.close();await rm(base,{force:true,recursive:true});});
  const pixels=randomBytes(512*512*3);
  const data=await sharp(pixels,{raw:{width:512,height:512,channels:3}}).png().toBuffer();
  const screenshot=await runtime.services.__storeScreenshot(data);
  const ordinary=await cache.put({data,kind:'image',origin:'import',mimeType:'image/png'});
  const canTransfer=createMediaTransferPermission({
    getCategories:()=>runtime.policyManager.get().categories,
    isCaptureArtifact:id=>runtime.services.__artifactRequiresCapture(id)
  });
  return {runtime,canTransfer,screenshot,ordinary,data};
}

function local(f){
  return createLocalMediaAgent({
    readImage:id=>f.runtime.services.__readImageBytes(id,{screenshotApproved:true}),
    canTransfer:f.canTransfer
  });
}
const args=(requestId,transferId,index=0,offset=0)=>({command:'media.chunk',requestId,secret,transferId,index,offset});

test('R01 Local: browserCapture Allow->Ask cancels screenshot get_cached_image mid-transfer and cannot resume',async t=>{
  const f=await fixture(t),agent=local(f);
  t.after(()=>agent.close());
  const id=f.screenshot.artifactId, result=await f.runtime.dispatch('get_cached_image',{artifactId:id});
  assert.equal(agent.authorize({requestId:'a',secret,tool:'get_cached_image',result}),true);
  const opened=(await agent.command({command:'media.open',requestId:'a',secret,artifactId:id})).media;
  assert.ok(opened.size>MEDIA_CHUNK_BYTES);
  const first=(await agent.command(args('a',opened.transferId))).media;
  assert.equal(first.length,MEDIA_CHUNK_BYTES);
  await f.runtime.policyManager.setCategory('browserCapture','ask');
  assert.equal(f.runtime.policyManager.get().categories.imageRead,'allow');
  await assert.rejects(agent.command(args('a',opened.transferId,1,MEDIA_CHUNK_BYTES)),{code:'MEDIA_DENIED'});
  await f.runtime.policyManager.setCategory('browserCapture','allow');
  await assert.rejects(agent.command(args('a',opened.transferId,1,MEDIA_CHUNK_BYTES)),{code:'MEDIA_DENIED'});
  const newResult=await f.runtime.dispatch('get_cached_image',{artifactId:id});
  agent.authorize({requestId:'b',secret,tool:'get_cached_image',result:newResult});
  const next=(await agent.command({command:'media.open',requestId:'b',secret,artifactId:id})).media;
  assert.notEqual(next.transferId,opened.transferId);
  assert.equal((await agent.command(args('b',next.transferId))).media.length,MEDIA_CHUNK_BYTES);
});

test('R01 Local: Allow->Ask denies screenshot binary at open; normal imported image remains readable',async t=>{
  const f=await fixture(t),agent=local(f);
  t.after(()=>agent.close());
  const id=f.screenshot.artifactId,shot=await f.runtime.dispatch('get_cached_image',{artifactId:id});
  agent.authorize({requestId:'a',secret,tool:'get_cached_image',result:shot});
  await f.runtime.policyManager.setCategory('browserCapture','ask');
  await assert.rejects(agent.command({command:'media.open',requestId:'a',secret,artifactId:id}),{code:'MEDIA_DENIED'});
  const normal=await f.runtime.dispatch('get_cached_image',{artifactId:f.ordinary.id});
  agent.authorize({requestId:'normal',secret,tool:'get_cached_image',result:normal});
  const opened=(await agent.command({command:'media.open',requestId:'normal',secret,artifactId:f.ordinary.id})).media;
  assert.equal((await agent.command(args('normal',opened.transferId))).media.length,MEDIA_CHUNK_BYTES);
  await f.runtime.policyManager.setCategory('imageRead','ask');
  await assert.rejects(agent.command(args('normal',opened.transferId,1,MEDIA_CHUNK_BYTES)),{code:'MEDIA_DENIED'});
  await f.runtime.policyManager.setCategory('imageRead','allow');
  await assert.rejects(agent.command(args('normal',opened.transferId,1,MEDIA_CHUNK_BYTES)),{code:'MEDIA_DENIED'});
});

test('R01 Local: browser_screenshot direct transfer requires current capture Allow (not Ask)',async t=>{
  const f=await fixture(t),agent=local(f);
  t.after(()=>agent.close());
  const id=f.screenshot.artifactId,result=await f.runtime.dispatch('get_cached_image',{artifactId:id});
  agent.authorize({requestId:'s',secret,tool:'browser_screenshot',result});
  await f.runtime.policyManager.setCategory('browserCapture','ask');
  await assert.rejects(agent.command({command:'media.open',requestId:'s',secret,artifactId:id}),{code:'MEDIA_DENIED'});
  await f.runtime.policyManager.setCategory('browserCapture','allow');
  await assert.rejects(agent.command({command:'media.open',requestId:'s',secret,artifactId:id}),{code:'MEDIA_DENIED'});
});

test('R01 Cloud: Allow->Ask cancels screenshot transfer between acknowledged chunks; no completion',async t=>{
  const f=await fixture(t),frames=[];
  const result=await f.runtime.dispatch('get_cached_image',{artifactId:f.screenshot.artifactId});
  let bridge;
  bridge=createCloudMediaBridge({
    instanceId:'inst_r01',
    readImage:id=>f.runtime.services.__readImageBytes(id,{screenshotApproved:true}),
    canTransfer:(tool,item)=>f.canTransfer({tool,artifactId:item.artifactId}),
    send:async frame=>{
      frames.push(frame);
      const id=frame.transferId;
      if(frame.type==='media.transfer.open')queueMicrotask(()=>bridge.receive({
        type:'media.transfer.accept',instanceId:'inst_r01',transferId:id,requestId:'transfer',accepted:true
      }));
      if(frame.type==='media.transfer.chunk'){
        await f.runtime.policyManager.setCategory('browserCapture','ask');
        queueMicrotask(()=>bridge.receive({
          type:'media.transfer.ack',instanceId:'inst_r01',transferId:id,requestId:'transfer',
          index:frame.index,offset:frame.offset+frame.length
        }));
      }
    }
  });
  t.after(()=>bridge.stop());
  assert.equal(bridge.acceptCapabilities({instanceId:'inst_r01',version:1,
    features:['transfer-chunks-v1','image-content'],maxChunkBytes:MEDIA_CHUNK_BYTES}),true);
  await assert.rejects(bridge.sendImage('get_cached_image',result,'transfer'),{code:'MEDIA_DENIED'});
  assert.equal(frames.filter(x=>x.type==='media.transfer.chunk').length,1);
  assert.equal(frames.some(x=>x.type==='media.transfer.cancel'),true);
  assert.equal(frames.some(x=>x.type==='media.transfer.complete'),false);
});

test('R01 Cloud: imageRead Allow->Ask cancels normal-image transfer while browserCapture still Allow',async t=>{
  const f=await fixture(t),frames=[];
  const result=await f.runtime.dispatch('get_cached_image',{artifactId:f.ordinary.id});
  let bridge;
  bridge=createCloudMediaBridge({
    instanceId:'inst_r01',
    readImage:id=>f.runtime.services.__readImageBytes(id,{screenshotApproved:true}),
    canTransfer:(tool,item)=>f.canTransfer({tool,artifactId:item.artifactId}),
    send:async frame=>{
      frames.push(frame);
      if(frame.type==='media.transfer.open')queueMicrotask(()=>bridge.receive({
        type:'media.transfer.accept',instanceId:'inst_r01',transferId:frame.transferId,requestId:'ordinary',accepted:true
      }));
      if(frame.type==='media.transfer.chunk'){
        await f.runtime.policyManager.setCategory('imageRead','ask');
        queueMicrotask(()=>bridge.receive({
          type:'media.transfer.ack',instanceId:'inst_r01',transferId:frame.transferId,requestId:'ordinary',
          index:frame.index,offset:frame.offset+frame.length
        }));
      }
    }
  });
  t.after(()=>bridge.stop());
  assert.equal(bridge.acceptCapabilities({instanceId:'inst_r01',version:1,
    features:['transfer-chunks-v1','image-content'],maxChunkBytes:MEDIA_CHUNK_BYTES}),true);
  await assert.rejects(bridge.sendImage('get_cached_image',result,'ordinary'),{code:'MEDIA_DENIED'});
  assert.equal(frames.filter(x=>x.type==='media.transfer.chunk').length,1);
  assert.equal(frames.some(x=>x.type==='media.transfer.cancel'),true);
});

test('R01: policy changes during asynchronous provenance lookup are checked after lookup',async()=>{
  const categories={browserCapture:'allow',imageRead:'allow'};
  let release;
  const barrier=new Promise(resolve=>{release=resolve;});
  const canTransfer=createMediaTransferPermission({
    getCategories:()=>categories,
    isCaptureArtifact:async()=>{await barrier;return true;}
  });
  const pending=canTransfer({tool:'get_cached_image',artifactId:'art_1'});
  categories.browserCapture='ask';
  release();
  assert.equal(await pending,false);
  assert.equal(await canTransfer({tool:'browser_screenshot',artifactId:'art_1'}),false);
  categories.browserCapture='allow';
  categories.imageRead='deny';
  assert.equal(await canTransfer({tool:'get_cached_image',artifactId:'art_1'}),false);
  categories.imageRead='allow';
  assert.equal(await canTransfer({tool:'get_cached_image',artifactId:'art_1'}),true);
});
