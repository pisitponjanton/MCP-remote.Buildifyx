import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createCloudImageImportReceiver } from '../../src/transport/media/inbound.js';
import { createImageServices } from '../../src/image/service.js';

const sharp = createRequire(import.meta.url)('sharp');

const wait=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check,label){
  for(let i=0;i<60;i++){const result=check();if(result)return result;await wait();}
  throw new Error('Timed out: '+label);
}
async function makeImage(){
  return sharp({create:{width:3,height:3,channels:3,background:'#aa33cc'}}).png().toBuffer();
}
function setup({canImport=()=>true,storeImage=async(bytes)=>({
  artifactId:'art_11111111-1111-4111-8111-111111111111',
  sha256:createHash('sha256').update(bytes).digest('hex')
})}={}){
  const messages=[];
  const receiver=createCloudImageImportReceiver({instanceId:'inst_test',
    send:async value=>{messages.push(value);},storeImage,canImport});
  receiver.accept(true);
  let count=0;
  const emit=async value=>{
    receiver.receive({instanceId:'inst_test',requestId:'req_test',transferId:'transfer_test',...value});
    return until(()=>messages.length>count?messages[count++]:null,value.type);
  };
  return {messages,receiver,emit};
}

test('negotiated Cloud -> Agent imports one PNG using ordered ACKed chunks and verified SHA-256',async()=>{
  const bytes=await makeImage(),sha256=createHash('sha256').update(bytes).digest('hex');
  const h=setup();
  try{
    assert.equal((await h.emit({type:'media.import.open',version:1,mimeType:'image/png',
      size:bytes.length,sha256,chunkBytes:128*1024})).type,'media.import.accept');
    assert.equal((await h.emit({type:'media.import.chunk',index:0,offset:0,length:bytes.length,data:bytes.toString('base64')})).offset,bytes.length);
    const end=await h.emit({type:'media.import.complete',size:bytes.length,sha256});
    assert.equal(end.type,'media.import.received');
    assert.equal(end.sha256,sha256);
    assert.equal(h.receiver.active,false);
  }finally{h.receiver.stop();}
});

test('malformed/chunk replay/forged SHA is rejected and discards receiver staging',async()=>{
  const bytes=await makeImage(),sha256=createHash('sha256').update(bytes).digest('hex');
  const h=setup();
  try{
    await h.emit({type:'media.import.open',version:1,mimeType:'image/png',size:bytes.length,sha256,chunkBytes:128*1024});
    const bad=await h.emit({type:'media.import.chunk',index:1,offset:0,length:bytes.length,data:bytes.toString('base64')});
    assert.equal(bad.type,'media.import.error');
    assert.equal(h.receiver.active,false);
    await h.emit({type:'media.import.open',version:1,mimeType:'image/png',size:bytes.length,sha256,chunkBytes:128*1024});
    await h.emit({type:'media.import.chunk',index:0,offset:0,length:bytes.length,data:bytes.toString('base64')});
    const forged=await h.emit({type:'media.import.complete',size:bytes.length,sha256:'0'.repeat(64)});
    assert.equal(forged.type,'media.import.error');
    assert.equal(h.receiver.active,false);
  }finally{h.receiver.stop();}
});

test('permission is local-only and an abort/disconnect erases pending temporary stage',async()=>{
  let allowed=false,clears=0;
  const bytes=await makeImage(),sha256=createHash('sha256').update(bytes).digest('hex');
  const h=setup({canImport:()=>allowed});
  try{
    assert.equal((await h.emit({type:'media.import.open',version:1,mimeType:'image/png',
      size:bytes.length,sha256,chunkBytes:128*1024})).code,'MEDIA_IMPORT_PERMISSION_REQUIRED');
    allowed=true;
    await h.emit({type:'media.import.open',version:1,mimeType:'image/png',size:bytes.length,sha256,chunkBytes:128*1024});
    assert.equal(h.receiver.active,true);
    h.receiver.reset();
    assert.equal(h.receiver.active,false);
    // Enabled flag must be renegotiated on the new authenticated connection.
    const denied=await h.emit({type:'media.import.open',version:1,mimeType:'image/png',size:bytes.length,sha256,chunkBytes:128*1024});
    assert.equal(denied.code,'UNSUPPORTED_CAPABILITY');
  }finally{h.receiver.stop();}
});

test('runtime-only imported artifacts are never written into shared disk cache and require explicit local allow',async()=>{
  const bytes=await makeImage();
  const policy={categories:{imageRead:'ask',cacheManage:'allow',browserCapture:'deny'}};
  const image=createImageServices({root:process.cwd(),getPolicy:()=>policy,
    cache:{close(){},initialize:async()=>{},list:async()=>[] ,get:async()=>{throw new Error('Disk cache must not be called');}}});
  try{
    await assert.rejects(()=>image.__importCloudImage(bytes),(e)=>e.code==='MEDIA_IMPORT_PERMISSION_REQUIRED');
    policy.categories.imageRead='allow';
    const stored=await image.__importCloudImage(bytes);
    assert.match(stored.artifactId,/^art_[0-9a-f-]{36}$/);
    assert.equal((await image.get_cached_image({artifactId:stored.artifactId})).sha256,stored.sha256);
    const raw=await image.__readImageBytes(stored.artifactId);
    assert.equal(raw.data.equals(bytes),true);
    assert.equal(await image.__artifactRequiresCapture(stored.artifactId),false);
    policy.categories.imageRead='deny';
    await assert.rejects(()=>image.get_cached_image({artifactId:stored.artifactId}),(e)=>e.code==='MEDIA_IMPORT_PERMISSION_REQUIRED');
    image.__clearCloudImports();
    assert.equal(raw.data.every(x=>x===0),true);
  }finally{image.closeImageCache();}
});

test('import remains temporary unless user explicitly invokes authorized save_cached_image',async()=>{
  const { mkdtemp, readdir, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const folder=await mkdtemp(join(tmpdir(),'bdxa-import-'));
  const bytes=await makeImage();
  const policy={categories:{imageRead:'allow',cacheManage:'allow',browserCapture:'deny'}};
  const image=createImageServices({root:folder,getPolicy:()=>policy,
    cache:{close(){},initialize:async()=>{},list:async()=>[] ,get:async()=>{throw new Error('Disk cache must not be called');}}});
  try{
    const created=await image.__importCloudImage(bytes);
    assert.deepEqual(await readdir(folder),[]);
    const file=join(folder,'explicit.png');
    const saved=await image.save_cached_image({artifactId:created.artifactId,destinationPath:file},{
      commitSideEffect:()=>{},throwIfCancelled:()=>{}
    });
    assert.equal(saved.saved,true);
    assert.equal((await readFile(file)).equals(bytes),true);
  }finally{image.closeImageCache();await rm(folder,{recursive:true,force:true});}
});

test('stale asynchronous media frames cannot cross WebSocket reconnect or renegotiation',async()=>{
  const png=await makeImage();
  const digest=createHash('sha256').update(png).digest('hex');
  let release,entered;
  const firstEntered=new Promise(resolve=>{entered=resolve;});
  const firstBlocked=new Promise(resolve=>{release=resolve;});
  let first=true,currentSocket='old';
  const messages=[],stored=[];
  const r=createCloudImageImportReceiver({instanceId:'inst_test',
    current:source=>source===currentSocket,
    canImport:async()=>{
      if(first){first=false;entered();await firstBlocked;}
      return true;
    },
    send:async reply=>{messages.push(reply);},
    storeImage:async data=>{stored.push(Buffer.from(data));return{
      artifactId:'art_11111111-1111-4111-8111-111111111111',
      sha256:createHash('sha256').update(data).digest('hex')
    }}
  });
  const oldId={instanceId:'inst_test',requestId:'old_request',transferId:'old_transfer'};
  const newId={instanceId:'inst_test',requestId:'new_request',transferId:'new_transfer'};
  const open={type:'media.import.open',version:1,size:png.length,mimeType:'image/png',sha256:digest,chunkBytes:128*1024};
  try{
    r.accept(true);
    r.receive({...oldId,...open},'old');
    await firstEntered;
    // Queue an extra old-session frame while permission resolution is pending.
    r.receive({...oldId,type:'media.import.chunk',index:0,offset:0,
      length:png.length,data:png.toString('base64')},'old');
    r.reset();
    currentSocket='new';
    r.accept(true);
    release();
    await wait();await wait();
    assert.equal(r.active,false);
    assert.equal(messages.filter(msg=>msg.requestId==='old_request').length,0);
    assert.equal(stored.length,0);
    r.receive({...newId,...open},'new');
    await until(()=>messages.some(msg=>msg.type==='media.import.accept'&&msg.requestId==='new_request'),'new accept');
    r.receive({...newId,type:'media.import.chunk',index:0,offset:0,length:png.length,
      data:png.toString('base64')},'new');
    await until(()=>messages.some(msg=>msg.type==='media.import.ack'&&msg.requestId==='new_request'),'new chunk');
    r.receive({...newId,type:'media.import.complete',size:png.length,sha256:digest},'new');
    await until(()=>messages.some(msg=>['media.import.received','media.import.error'].includes(msg.type)&&msg.requestId==='new_request'),'new complete response');
    assert.equal(messages.find(msg=>['media.import.received','media.import.error'].includes(msg.type)&&msg.requestId==='new_request')?.type,'media.import.received',JSON.stringify(messages));
    assert.equal(stored.length,1);
  }finally{release?.();r.stop();for(const data of stored)data.fill(0);}
});

test('disconnect during asynchronous image decode erases a late temporary-cache commit',async()=>{
  const png=await makeImage();
  const sha256=createHash('sha256').update(png).digest('hex');
  let decodeStarted,finishDecode;
  const decoderEntered=new Promise(resolve=>{decodeStarted=resolve;});
  const decoderReleased=new Promise(resolve=>{finishDecode=resolve;});
  let temporaryBytes=null,resetCount=0;
  const responses=[];
  const receiver=createCloudImageImportReceiver({
    instanceId:'inst_test',
    send:async msg=>{responses.push(msg);},
    canImport:()=>true,
    storeImage:async bytes=>{
      decodeStarted();
      await decoderReleased;
      temporaryBytes=Buffer.from(bytes);
      return {artifactId:'art_11111111-1111-4111-8111-111111111111',
        sha256:createHash('sha256').update(bytes).digest('hex')};
    },
    clearImages:()=>{resetCount++;temporaryBytes?.fill(0);temporaryBytes=null;}
  });
  const identity={instanceId:'inst_test',requestId:'late_decode',transferId:'late_transfer'};
  try{
    receiver.accept(true);
    receiver.receive({...identity,type:'media.import.open',version:1,
      size:png.length,mimeType:'image/png',sha256,chunkBytes:128*1024});
    await until(()=>responses.some(msg=>msg.type==='media.import.accept'),'accept');
    receiver.receive({...identity,type:'media.import.chunk',index:0,
      offset:0,length:png.length,data:png.toString('base64')});
    await until(()=>responses.some(msg=>msg.type==='media.import.ack'),'ack');
    receiver.receive({...identity,type:'media.import.complete',size:png.length,sha256});
    await decoderEntered;
    receiver.reset();
    finishDecode();
    await wait();await wait();
    assert.ok(resetCount>=2,'disconnect and late decode must both clear temporary bytes');
    assert.equal(temporaryBytes,null);
    assert.equal(receiver.active,false);
    assert.equal(responses.some(msg=>msg.type==='media.import.received'),false);
  }finally{finishDecode?.();receiver.stop();}
});
