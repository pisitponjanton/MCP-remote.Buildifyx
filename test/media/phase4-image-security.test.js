import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCloudImageImportReceiver } from '../../src/transport/media/inbound.js';
import { createImageServices } from '../../src/image/service.js';
import { createRuntime } from '../../src/core/runtime.js';
import { normalizePolicy } from '../../src/permissions/policy.js';

const sharp = createRequire(import.meta.url)('sharp');
const digest = b => createHash('sha256').update(b).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
const png = () => sharp({create:{width:12,height:9,channels:3,background:'#124578'}}).png().toBuffer();
const artifactId='art_12345678-1234-4234-8234-123456789abc';

async function awaitReply(messages, expected) {
  for(let i=0;i<150;i++){
    const m=messages.find(m=>m.type===expected);
    if(m)return m;
    await tick();
  }
  throw new Error('No reply: '+expected);
}
function fixtureReceiver(t, opts={}) {
  const replies=[], stored=[];
  let allowed=true, now=0, liveSocket='socket_a', cleared=0;
  const receiver=createCloudImageImportReceiver({
    instanceId:'inst_a', now:()=>now,
    current:src=>src===liveSocket,
    canImport:()=>allowed,
    storeImage:async bytes=>{
      stored.push(Buffer.from(bytes));
      return {artifactId,sha256:digest(bytes)};
    },
    clearImages:()=>{cleared++;for(const b of stored)b.fill(0);stored.length=0;},
    send:async m=>{replies.push(m);}
  });
  receiver.accept(true);
  t.after(()=>{receiver.stop();for(const b of stored)b.fill(0);});
  const base={instanceId:'inst_a',requestId:'req_a',transferId:'xfer_a'};
  const send=(m,source='socket_a')=>receiver.receive({...base,...m},source);
  const open=(bytes,extra={})=>send({type:'media.import.open',version:1,mimeType:'image/png',
    size:bytes.length,sha256:digest(bytes),chunkBytes:131072,...extra});
  return {receiver,replies,stored,send,open,base,
    setAllowed:v=>{allowed=v;},advance:ms=>{now+=ms;},
    setSocket:v=>{liveSocket=v;},get cleared(){return cleared;}};
}

test('Phase4: malformed/oversized transfers fail closed before staging or storing',async t=>{
  const b=await png();
  for(const [title,alter] of [
    ['oversize', {size:4*1024*1024+1}],
    ['invalid MIME', {mimeType:'image/gif'}],
    ['wrong chunk bytes', {chunkBytes:65536}],
    ['invalid checksum', {sha256:'bad'}]
  ]){
    await t.test(title,async tt=>{
      const f=fixtureReceiver(tt);
      f.open(b,alter);
      assert.equal((await awaitReply(f.replies,'media.import.error')).code,'MEDIA_IMPORT_INVALID');
      assert.equal(f.receiver.active,false);
      assert.equal(f.stored.length,0);
    });
  }
});

test('Phase4: spoofed MIME, corrupt checksum, repeated chunk and base64 mutation discard pending bytes',async t=>{
  const original=await png(),hash=digest(original);
  for(const scenario of ['replay','invalid base64','bad digest','wrong MIME magic']){
    await t.test(scenario,async tt=>{
      const f=fixtureReceiver(tt);
      f.open(original);
      await awaitReply(f.replies,'media.import.accept');
      const good={type:'media.import.chunk',index:0,offset:0,length:original.length,data:original.toString('base64')};
      if(scenario==='invalid base64')f.send({...good,data:'###'});
      else if(scenario==='wrong MIME magic')f.send({...good,data:Buffer.alloc(original.length,0).toString('base64')});
      else f.send(good);
      if(scenario==='replay') {
        await awaitReply(f.replies,'media.import.ack');
        f.send(good);
      }else if(scenario==='bad digest'||scenario==='wrong MIME magic'){
        if(scenario==='bad digest') {
          await awaitReply(f.replies,'media.import.ack');
          f.send({type:'media.import.complete',size:original.length,sha256:'f'.repeat(64)});
        }else{
          await awaitReply(f.replies,'media.import.ack');
          f.send({type:'media.import.complete',size:original.length,sha256:hash});
        }
      }
      assert.equal((await awaitReply(f.replies,'media.import.error')).code,'MEDIA_IMPORT_INVALID');
      assert.equal(f.receiver.active,false);
      assert.equal(f.stored.length,0);
    });
  }
});

test('Phase4: wrong instance/socket, permission downgrade, cancellation, timeout and post-reconnect frames are fenced',async t=>{
  const b=await png();
  const f=fixtureReceiver(t);
  f.send({type:'media.import.open',size:b.length,version:1,mimeType:'image/png',chunkBytes:131072,sha256:digest(b),instanceId:'inst_other'});
  await tick();
  assert.equal(f.replies.length,0,'wrong instance receives no response');
  f.open(b);await awaitReply(f.replies,'media.import.accept');
  assert.equal(f.receiver.active,true);
  f.setAllowed(false);
  f.send({type:'media.import.chunk',index:0,offset:0,length:b.length,data:b.toString('base64')});
  assert.equal((await awaitReply(f.replies,'media.import.error')).code,'MEDIA_IMPORT_PERMISSION_REQUIRED');
  assert.equal(f.receiver.active,false);
  f.setAllowed(true);
  f.open(b);await tick();
  f.send({type:'media.import.cancel'});
  for(let i=0;i<8;i++)await tick();
  assert.equal(f.receiver.active,false);
  f.open(b);await tick();
  f.advance(30_001);
  f.send({type:'media.import.chunk',index:0,offset:0,length:b.length,data:b.toString('base64')});
  await tick();
  assert.equal(f.receiver.active,false);
  f.receiver.reset();
  f.setSocket('socket_b');
  f.send({type:'media.import.open',size:b.length,version:1,mimeType:'image/png',chunkBytes:131072,sha256:digest(b)},'socket_a');
  await tick();
  assert.equal(f.stored.length,0);
  assert.equal(f.receiver.active,false);
});

test('Phase4: runtime import owner separation, local policy downgrade and RAM zeroization',async t=>{
  const b=await png();
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'bdxa-phase4-')));
  const r1=path.join(base,'workspace-a'),r2=path.join(base,'workspace-b');
  await mkdir(r1);await mkdir(r2);
  const opts=root=>createRuntime({root,namespace:'cloud',interactive:false,
    policy:normalizePolicy({categories:{imageRead:'allow',cacheManage:'allow',imageSave:'allow',outsideRoot:'deny'}}),
    imageCache:{initialize:async()=>{},close(){},list:async()=>[],get:async()=>{throw Error('Not disk cache');}}
  });
  const a=opts(r1),other=opts(r2);
  t.after(async()=>{await a.stop();await other.stop();await rm(base,{recursive:true,force:true});});
  const meta=await a.services.__importCloudImage(b);
  const ref=await a.services.__readImageBytes(meta.artifactId);
  assert.equal(ref.data.equals(b),true);
  await assert.rejects(other.dispatch('get_cached_image',{artifactId:meta.artifactId}));
  await assert.rejects(other.dispatch('save_cached_image',{artifactId:meta.artifactId,destinationPath:'no.png'}));
  await a.policyManager.setCategory('cacheManage','ask');
  assert.equal(ref.data.every(value=>value===0),true,'downgrade must zero existing RAM data');
  await assert.rejects(a.dispatch('get_cached_image',{artifactId:meta.artifactId}));
  assert.deepEqual(await readdir(r1),[]);
  assert.deepEqual(await readdir(r2),[]);
});

test('Phase4: revocation at late permanent-save checkpoint must abort rather than write erased RAM',async t=>{
  const b=await png();
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'bdxa-phase4-late-save-')));
  const root=path.join(base,'workspace');
  await mkdir(root);
  const runtime=createRuntime({root,namespace:'cloud',interactive:false,
    policy:normalizePolicy({categories:{imageRead:'allow',cacheManage:'allow',imageSave:'allow',outsideRoot:'deny'}}),
    imageCache:{initialize:async()=>{},close(){},list:async()=>[],get:async()=>{throw Error('Not disk cache');}}
  });
  t.after(async()=>{await runtime.stop();await rm(base,{recursive:true,force:true});});
  const meta=await runtime.services.__importCloudImage(b);
  const original=runtime.services.save_cached_image;
  let checkpoints=0;
  runtime.services.save_cached_image=(input,context)=>original(input,{
    ...context,
    assertStillAllowed(){
      checkpoints++;
      if(checkpoints===1) {
        // Deterministic actual policy manager update, analogous to permission revoked
        // while destination path classification is running.
        const categories=runtime.policyManager.get().categories;
        categories.cacheManage='deny';
        runtime.services.__clearCloudImports();
      }
      context.assertStillAllowed();
    }
  });
  await assert.rejects(
    runtime.dispatch('save_cached_image',{artifactId:meta.artifactId,destinationPath:'revoked.png'}),
    e=>e.code==='MEDIA_IMPORT_PERMISSION_REQUIRED'
  );
  assert.ok(checkpoints>=1);
  assert.equal(existsSync(path.join(root,'revoked.png')),false);
});

test('Phase4: clearing RAM after authorized save commit does not corrupt the output file',async t=>{
  const bytes=await png();
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'bdxa-phase4-commit-')));
  const root=path.join(base,'workspace');
  await mkdir(root);
  const runtime=createRuntime({root,namespace:'cloud',interactive:false,
    policy:normalizePolicy({categories:{imageRead:'allow',cacheManage:'allow',imageSave:'allow',outsideRoot:'deny'}}),
    imageCache:{initialize:async()=>{},close(){},list:async()=>[],get:async()=>{throw Error('Not disk cache');}}
  });
  t.after(async()=>{await runtime.stop();await rm(base,{recursive:true,force:true});});
  const meta=await runtime.services.__importCloudImage(bytes);
  const memory=(await runtime.services.__readImageBytes(meta.artifactId)).data;
  const original=runtime.services.save_cached_image;
  runtime.services.save_cached_image=(input,context)=>original(input,{
    ...context,
    commitSideEffect(){
      context.commitSideEffect?.();
      runtime.services.__clearCloudImports();
    }
  });
  const result=await runtime.dispatch('save_cached_image',{artifactId:meta.artifactId,destinationPath:'approved.png'});
  assert.equal(result.saved,true);
  assert.equal(result.sha256,digest(bytes));
  assert.deepEqual(await readFile(path.join(root,'approved.png')),bytes);
  assert.equal(memory.every(x=>x===0),true,'session RAM was cleared when the authorized write committed');
});