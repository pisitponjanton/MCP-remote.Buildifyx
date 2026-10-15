import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createCloudImageImportReceiver } from '../../src/transport/media/inbound.js';
import { createImageServices } from '../../src/image/service.js';

const sharp=createRequire(import.meta.url)('sharp');
const sha=b=>createHash('sha256').update(b).digest('hex');
const png=()=>sharp({create:{width:7,height:5,channels:3,background:'#236789'}}).png().toBuffer();
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function waitFor(replies,type) {
  for(let i=0;i<100;i++){
    const found=replies.find(x=>x.type===type);
    if(found)return found;
    await tick();
  }
  throw Error('Missing '+type);
}
test('Phase4: RAM import expires after five minutes and zeroes its byte buffer',async ()=>{
  const oldNow=Date.now;
  let fakeNow=1_700_000_000_000;
  Date.now=()=>fakeNow;
  const policy={categories:{imageRead:'allow',cacheManage:'allow'}};
  const image=createImageServices({root:process.cwd(),getPolicy:()=>policy,
    cache:{initialize:async()=>{},close(){},list:async()=>[],
      get:async()=>{const e=Error('Not found');e.code='CACHE_NOT_FOUND';throw e;}}});
  try{
    const bytes=await png();
    const entry=await image.__importCloudImage(bytes);
    const ref=(await image.__readImageBytes(entry.artifactId)).data;
    assert.equal(ref.equals(bytes),true);
    fakeNow+=300_001;
    assert.deepEqual((await image.list_cached_assets()).assets,[]);
    assert.equal(ref.every(x=>x===0),true,'expired RAM must be zeroized, not just removed from map');
    await assert.rejects(image.get_cached_image({artifactId:entry.artifactId}));
  } finally {
    Date.now=oldNow;
    image.closeImageCache();
  }
});

test('Phase4: duplicate open is refused, cancellation discards staging, pending bytes cannot replay',async t=>{
  const bytes=await png(),replies=[],stored=[];
  const receiver=createCloudImageImportReceiver({instanceId:'inst1',
    canImport:()=>true,
    storeImage:async b=>{stored.push(Buffer.from(b));return {
      artifactId:'art_33333333-3333-4333-8333-333333333333',sha256:sha(b)};},
    send:async m=>{replies.push(m);}
  });
  t.after(()=>{receiver.stop();for(const x of stored)x.fill(0);});
  receiver.accept(true);
  const base={instanceId:'inst1',requestId:'req1',transferId:'tr1'};
  const send=m=>receiver.receive({...base,...m});
  const open={type:'media.import.open',version:1,size:bytes.length,sha256:sha(bytes),mimeType:'image/png',chunkBytes:131072};
  send(open);
  await waitFor(replies,'media.import.accept');
  send({...open,requestId:'req2',transferId:'tr2'});
  assert.equal((await waitFor(replies,'media.import.error')).code,'MEDIA_IMPORT_BUSY');
  assert.equal(receiver.active,true,'second open must not destroy the first authorized transfer');
  send({type:'media.import.cancel'});
  for(let i=0;i<4;i++)await tick();
  assert.equal(receiver.active,false);
  send({type:'media.import.chunk',index:0,offset:0,length:bytes.length,data:bytes.toString('base64')});
  for(let i=0;i<8;i++)await tick();
  assert.equal(stored.length,0);
});

test('Phase4: queue overload gets fail-closed rate response and does not commit image bytes',async t=>{
  const messages=[],stored=[];
  let release,entered;
  const locked=new Promise(resolve=>{release=resolve;});
  const reached=new Promise(resolve=>{entered=resolve;});
  let once=true;
  const r=createCloudImageImportReceiver({instanceId:'inst1',
    canImport:async()=>{if(once){once=false;entered();await locked;}return true;},
    storeImage:async b=>{stored.push(b);return {
      artifactId:'art_33333333-3333-4333-8333-333333333333',sha256:sha(b)};},
    send:async m=>{messages.push(m);}
  });
  t.after(()=>{release?.();r.stop();});
  r.accept(true);
  const identity={instanceId:'inst1',requestId:'slow',transferId:'slow'};
  const bytes=await png();
  r.receive({...identity,type:'media.import.open',version:1,size:bytes.length,sha256:sha(bytes),mimeType:'image/png',chunkBytes:131072});
  await reached;
  for(let i=0;i<70;i++)r.receive({...identity,type:'media.import.chunk',index:i,offset:0,length:1,data:'AA=='});
  await waitFor(messages,'media.import.error');
  assert.equal(messages.some(x=>x.code==='MEDIA_IMPORT_BUSY'),true);
  release();
  for(let i=0;i<100;i++)await tick();
  assert.equal(stored.length,0);
  assert.equal(r.active,false);
});
