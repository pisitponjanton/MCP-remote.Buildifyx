import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createRequire } from 'node:module';
import { createCloudAgent } from '../../src/transport/cloud.js';
import { createImageServices } from '../../src/image/service.js';

const sharp = createRequire(import.meta.url)('sharp');

function waitFor(predicate, ms=3000){
  const start=Date.now();
  return new Promise((resolve,reject)=>{
    const next=()=>{
      const value=predicate();if(value)return resolve(value);
      if(Date.now()-start>ms)return reject(new Error('timed out waiting for Agent event'));
      setTimeout(next,5);
    };next();
  });
}
test('actual Cloud Agent WebSocket accepts explicitly negotiated import into temporary runtime RAM only',async()=>{
  const wss=new WebSocketServer({port:0,path:'/agent'});
  await new Promise(resolve=>wss.once('listening',resolve));
  const addr=wss.address();if(!addr||typeof addr!=='object')throw Error('listener');
  const policy={categories:{imageRead:'allow',cacheManage:'allow',browserCapture:'deny'}};
  const image=createImageServices({root:process.cwd(),getPolicy:()=>policy});
  const received=[],peers=new Set();
  wss.on('connection',sock=>{
    peers.add(sock);
    sock.on('close',()=>peers.delete(sock));
    sock.on('message',raw=>{try{received.push(JSON.parse(raw.toString()));}catch{}});
  });
  const runtime={services:image,policyManager:{get:()=>policy},async dispatch(){return {};},cancel(){}};
  const agent=createCloudAgent({
    cloudUrl:'http://127.0.0.1:'+addr.port,credentials:{deviceId:'dev_import',deviceToken:'dev_token'},
    runtime,manifest:{count:2,hash:'hash',manifestVersion:1,tools:[{name:'get_cached_image'},{name:'read_image'}]},
    version:'0.4.0',instance:{instanceId:'inst_import',name:'workspace',path:process.cwd(),mode:'background'},
    deviceInfo:{platform:process.platform,arch:process.arch},reconnect:false
  });
  const imageBuffer=await sharp({create:{width:2,height:2,channels:3,background:'#123456'}}).png().toBuffer();
  const sha256=createHash('sha256').update(imageBuffer).digest('hex');
  const identity={instanceId:'inst_import',requestId:'req_image_import',transferId:'transfer_image_import'};
  try{
    agent.connect();
    const ready=await waitFor(()=>received.find(v=>v.type==='device.ready'));
    assert.ok(ready.capabilities.media.features.includes('image-import-v1'));
    const sock=await waitFor(()=>[...peers][0]);
    const send=m=>sock.send(JSON.stringify(m));
    send({type:'media.capabilities.accept',instanceId:'inst_import',version:1,
      features:['transfer-chunks-v1','image-content','image-import-v1'],maxChunkBytes:131072});
    send({type:'media.import.open',...identity,version:1,sha256,size:imageBuffer.length,
      mimeType:'image/png',chunkBytes:131072});
    assert.equal((await waitFor(()=>received.find(v=>v.type==='media.import.accept'))).accepted,true);
    send({type:'media.import.chunk',...identity,index:0,offset:0,length:imageBuffer.length,data:imageBuffer.toString('base64')});
    assert.equal((await waitFor(()=>received.find(v=>v.type==='media.import.ack'))).offset,imageBuffer.length);
    send({type:'media.import.complete',...identity,size:imageBuffer.length,sha256});
    const completed=await waitFor(()=>received.find(v=>v.type==='media.import.received'));
    assert.match(completed.artifactId,/^art_[0-9a-f-]{36}$/);
    const metadata=await image.get_cached_image({artifactId:completed.artifactId});
    assert.equal(metadata.sha256,sha256);
    policy.categories.imageRead='deny';
    await assert.rejects(()=>image.get_cached_image({artifactId:completed.artifactId}),
      error=>error.code==='MEDIA_IMPORT_PERMISSION_REQUIRED');
    await agent.stop();
    const cached=await image.__readImageBytes(completed.artifactId).catch(()=>null);
    assert.equal(cached,null);
  }finally{
    await agent.stop().catch(()=>undefined);
    image.closeImageCache();
    for(const sock of peers)sock.terminate();
    await new Promise(resolve=>wss.close(()=>resolve()));
  }
});
