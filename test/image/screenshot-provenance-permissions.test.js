import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createRuntime } from '../../src/core/runtime.js';
import { createArtifactCache } from '../../src/cache/store.js';
import { normalizePolicy } from '../../src/permissions/policy.js';
import { createLocalMediaAgent } from '../../src/transport/media/local-agent.js';
import { createCloudMediaBridge } from '../../src/transport/media/cloud-bridge.js';
import { MEDIA_CHUNK_BYTES } from '../../src/transport/media/protocol.js';

const sharp = createRequire(import.meta.url)('sharp');

async function fixture(t,{capture='allow',interactive=false}={}) {
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'bdxa-f02-')));
  const root=path.join(base,'workspace');
  await mkdir(root);
  const cache=createArtifactCache({workspaceRoot:root,namespace:'local',homeDirectory:path.join(base,'home')});
  const runtime=createRuntime({root,namespace:'local',instanceId:'inst_f02',principalId:'principal_f02',
    imageCache:cache,interactive,policy:normalizePolicy({categories:{
      imageRead:'allow',imageSave:'allow',cacheManage:'allow',browserCapture:capture
    }})});
  t.after(async()=>{await runtime.stop().catch(()=>undefined);cache.close();await rm(base,{recursive:true,force:true});});
  const pixels=randomBytes(512*512*3);
  const png=await sharp(pixels,{raw:{width:512,height:512,channels:3}}).png().toBuffer();
  const screenshot=await runtime.services.__storeScreenshot(png);
  const normal=await cache.put({data:await sharp({create:{width:3,height:4,channels:3,background:'#aaa'}}).png().toBuffer(),
    kind:'image',origin:'import',mimeType:'image/png'});
  return {runtime,cache,root,screenshot,normal,png};
}
const secret='c'.repeat(64);
const protectedImageTools=[
  ['get_cached_image',a=>({artifactId:a})],
  ['get_image_info',a=>({artifactId:a})],
  ['resize_image',a=>({artifactId:a,width:200})],
  ['save_cached_image',a=>({artifactId:a,destinationPath:'blocked.png'})]
];

test('F02: revoked capture denies screenshot read/info/resize/save and internal binary reads; normal images remain usable',async t=>{
  const f=await fixture(t);
  const listed=await f.runtime.dispatch('list_cached_assets',{});
  assert.ok(listed.assets.some(a=>a.id===f.screenshot.artifactId));
  await f.runtime.policyManager.setCategory('browserCapture','deny');
  for(const [name,args] of protectedImageTools) {
    await assert.rejects(f.runtime.dispatch(name,args(f.screenshot.artifactId)),{code:'PERMISSION_DENIED'});
  }
  await assert.rejects(f.runtime.services.__readImageBytes(f.screenshot.artifactId,{screenshotApproved:true}),
    {code:'BROWSER_CAPTURE_DENIED'});
  const hidden=await f.runtime.dispatch('list_cached_assets',{});
  assert.ok(!hidden.assets.some(a=>a.id===f.screenshot.artifactId));
  assert.ok(hidden.assets.some(a=>a.id===f.normal.id));
  assert.equal((await f.runtime.dispatch('get_cached_image',{artifactId:f.normal.id})).mimeType,'image/png');
  assert.equal((await f.runtime.dispatch('save_cached_image',{artifactId:f.normal.id,destinationPath:'ordinary.png'})).saved,true);
  assert.ok(!existsSync(path.join(f.root,'blocked.png')));
});

test('F02: ASK must request additional browserCapture confirmation; approval permits only the authorized request',async t=>{
  const f=await fixture(t,{capture:'ask',interactive:true});
  const listed=await f.runtime.dispatch('list_cached_assets',{});
  assert.equal(listed.assets.some(a=>a.id===f.screenshot.artifactId),false,
    'Screenshot metadata must remain hidden when capture approval is not globally allowed');
  assert.equal(listed.assets.some(a=>a.id===f.normal.id),true);
  const deferred=f.runtime.dispatch('get_cached_image',{artifactId:f.screenshot.artifactId});
  let approval;
  for(let i=0;i<100&&!approval;i++){
    approval=f.runtime.approvalQueue.getPending().find(a=>a.category==='browserCapture');
    if(!approval)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(approval?.category,'browserCapture');
  assert.equal(f.runtime.approvalQueue.resolve(approval.id,{action:'allow',remember:null}),true);
  assert.equal((await deferred).mimeType,'image/png');
  await f.runtime.policyManager.setCategory('browserCapture','deny');
  await assert.rejects(f.runtime.dispatch('get_image_info',{artifactId:f.screenshot.artifactId}),{code:'PERMISSION_DENIED'});
});

test('F02: screenshot-derived resize keeps capture origin, including later resizing and denied reads',async t=>{
  const f=await fixture(t);
  const first=await f.runtime.dispatch('resize_image',{artifactId:f.screenshot.artifactId,width:160});
  const second=await f.runtime.dispatch('resize_image',{artifactId:first.artifactId,width:80});
  for(const artifactId of [first.artifactId,second.artifactId]){
    const item=await f.cache.get(artifactId);
    assert.equal(item.metadata.kind,'image');
    assert.equal(item.metadata.origin,'capture');
  }
  await f.runtime.policyManager.setCategory('browserCapture','deny');
  for(const artifactId of [first.artifactId,second.artifactId]){
    await assert.rejects(f.runtime.dispatch('get_cached_image',{artifactId}),{code:'PERMISSION_DENIED'});
    await assert.rejects(f.runtime.dispatch('resize_image',{artifactId,width:40}),{code:'PERMISSION_DENIED'});
    await assert.rejects(f.runtime.dispatch('save_cached_image',{artifactId,destinationPath:'derived.png'}),{code:'PERMISSION_DENIED'});
  }
  assert.equal(existsSync(path.join(f.root,'derived.png')),false);
});

test('F02: legacy generated entries are protected; newly resized ordinary images remain usable after revocation',async t=>{
  const f=await fixture(t);
  const legacy=await f.cache.put({data:f.png,kind:'image',origin:'generated',mimeType:'image/png'});
  const resized=await f.runtime.dispatch('resize_image',{artifactId:f.normal.id,width:2});
  assert.equal((await f.cache.get(resized.artifactId)).metadata.origin,'generated-safe');
  await f.runtime.policyManager.setCategory('browserCapture','deny');
  await assert.rejects(f.runtime.dispatch('get_cached_image',{artifactId:legacy.id}),{code:'PERMISSION_DENIED'});
  await assert.rejects(f.runtime.dispatch('save_cached_image',{artifactId:legacy.id,destinationPath:'legacy.png'}),{code:'PERMISSION_DENIED'});
  assert.equal((await f.runtime.dispatch('get_cached_image',{artifactId:resized.artifactId})).mimeType,'image/png');
  assert.equal((await f.runtime.dispatch('save_cached_image',{artifactId:resized.artifactId,destinationPath:'normal-resize.png'})).saved,true);
});

test('F02: Local media chunk from get_cached_image is denied after screenshot revocation despite imageRead allow',async t=>{
  const f=await fixture(t);
  const result=await f.runtime.dispatch('get_cached_image',{artifactId:f.screenshot.artifactId});
  const local=createLocalMediaAgent({
    readImage:id=>f.runtime.services.__readImageBytes(id,{screenshotApproved:true}),
    canTransfer:async({tool,artifactId})=>{
      const cats=f.runtime.policyManager.get().categories;
      return cats[tool==='browser_screenshot'?'browserCapture':'imageRead']!=='deny'
        && (!await f.runtime.services.__artifactRequiresCapture(artifactId) || cats.browserCapture!=='deny');
    }
  });
  t.after(()=>local.close());
  local.authorize({requestId:'f02',secret,tool:'get_cached_image',result});
  const offer=(await local.command({command:'media.open',requestId:'f02',secret,artifactId:result.artifactId})).media;
  assert.ok(offer.size>MEDIA_CHUNK_BYTES);
  const first=(await local.command({command:'media.chunk',requestId:'f02',secret,transferId:offer.transferId,index:0,offset:0})).media;
  assert.equal(first.length,MEDIA_CHUNK_BYTES);
  await f.runtime.policyManager.setCategory('browserCapture','deny');
  assert.equal(f.runtime.policyManager.get().categories.imageRead,'allow');
  await assert.rejects(local.command({command:'media.chunk',requestId:'f02',secret,
    transferId:offer.transferId,index:1,offset:MEDIA_CHUNK_BYTES}),{code:'MEDIA_DENIED'});
  await assert.rejects(local.command({command:'media.chunk',requestId:'f02',secret,
    transferId:offer.transferId,index:1,offset:MEDIA_CHUNK_BYTES}),{code:'MEDIA_DENIED'});
  // Denial destroyed the original transfer; it cannot resume after reapproval.
  await f.runtime.policyManager.setCategory('browserCapture','allow');
  await assert.rejects(local.command({command:'media.chunk',requestId:'f02',secret,
    transferId:offer.transferId,index:1,offset:MEDIA_CHUNK_BYTES}),{code:'MEDIA_DENIED'});
});

test('F02: Cloud media blocks screenshot-derived get_cached_image mid-transfer and emits cancellation',async t=>{
  const f=await fixture(t);
  const result=await f.runtime.dispatch('get_cached_image',{artifactId:f.screenshot.artifactId});
  const frames=[];
  let bridge;
  bridge=createCloudMediaBridge({
    instanceId:'inst_f02',
    readImage:id=>f.runtime.services.__readImageBytes(id,{screenshotApproved:true}),
    canTransfer:async(tool,item)=>{
      const categories=f.runtime.policyManager.get().categories;
      return categories[tool==='browser_screenshot'?'browserCapture':'imageRead']!=='deny'
        && (!await f.runtime.services.__artifactRequiresCapture(item.artifactId)||categories.browserCapture!=='deny');
    },
    send:async frame=>{
      frames.push(frame);
      const id=frame.transferId;
      if(frame.type==='media.transfer.open')queueMicrotask(()=>bridge.receive({type:'media.transfer.accept',instanceId:'inst_f02',transferId:id,requestId:'f02',accepted:true}));
      if(frame.type==='media.transfer.chunk'){
        await f.runtime.policyManager.setCategory('browserCapture','deny');
        queueMicrotask(()=>bridge.receive({type:'media.transfer.ack',instanceId:'inst_f02',transferId:id,requestId:'f02',index:frame.index,offset:frame.offset+frame.length}));
      }
    }
  });
  t.after(()=>bridge.stop());
  assert.equal(bridge.acceptCapabilities({instanceId:'inst_f02',version:1,features:['transfer-chunks-v1','image-content'],maxChunkBytes:MEDIA_CHUNK_BYTES}),true);
  await assert.rejects(bridge.sendImage('get_cached_image',result,'f02'),{code:'MEDIA_DENIED'});
  assert.equal(frames.filter(f=>f.type==='media.transfer.chunk').length,1);
  assert.equal(frames.some(f=>f.type==='media.transfer.cancel'),true);
  assert.equal(frames.some(f=>f.type==='media.transfer.complete'),false);
});
