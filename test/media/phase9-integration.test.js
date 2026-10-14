import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createLocalMediaAgent } from '../../src/transport/media/local-agent.js';
import { createCloudMediaBridge } from '../../src/transport/media/cloud-bridge.js';
import { MEDIA_CHUNK_BYTES, digest } from '../../src/transport/media/protocol.js';

const sharp = createRequire(import.meta.url)('sharp');

const secret='c'.repeat(64);
const artifactId='art_12345678-1234-1234-1234-123456789abc';
const createImage=()=>sharp({create:{width:640,height:480,channels:3,background:'#112233'}}).png().toBuffer();

test('Phase 9: local screenshot binary transfer cannot continue after browserCapture revocation even if imageRead remains enabled',async ()=>{
  const bytes=await createImage();
  const result={artifactId,mimeType:'image/png',size:bytes.length,sha256:digest(bytes),imageBytesDelivered:false};
  const allowed={imageRead:true,browserCapture:true};
  const transfer=createLocalMediaAgent({
    readImage:async()=>({data:bytes,metadata:{mimeType:'image/png'}}),
    canTransfer:({tool})=>allowed[tool==='browser_screenshot'?'browserCapture':'imageRead']
  });
  transfer.authorize({requestId:'screenshot',secret,tool:'browser_screenshot',result});
  const opened=await transfer.command({command:'media.open',requestId:'screenshot',secret,artifactId});
  assert.match(opened.media.transferId,/^transfer_/);
  allowed.browserCapture=false;
  assert.equal(allowed.imageRead,true);
  await assert.rejects(transfer.command({command:'media.chunk',requestId:'screenshot',secret,
    transferId:opened.media.transferId,index:0,offset:0}),{code:'MEDIA_DENIED'});
  await assert.rejects(transfer.command({command:'media.chunk',requestId:'screenshot',secret,
    transferId:opened.media.transferId,index:0,offset:0}),{code:'MEDIA_DENIED'});
  transfer.close();
});

test('Phase 9: local authenticated transfer denies mixing request secrets or replaying finished chunks',async()=>{
  const data=randomBytes(MEDIA_CHUNK_BYTES+5);
  const result={artifactId,mimeType:'image/png',size:data.length,sha256:digest(data),imageBytesDelivered:false};
  const transfer=createLocalMediaAgent({readImage:async()=>({data,metadata:{mimeType:'image/png'}})});
  transfer.authorize({requestId:'a',secret,tool:'browser_screenshot',result});
  await assert.rejects(transfer.command({command:'media.open',requestId:'b',secret,artifactId}),{code:'MEDIA_DENIED'});
  const opened=await transfer.command({command:'media.open',requestId:'a',secret,artifactId});
  const key=opened.media.transferId;
  await assert.rejects(transfer.command({command:'media.chunk',transferId:key,
    requestId:'a',secret:'f'.repeat(64),index:0,offset:0}),{code:'MEDIA_DENIED'});
  const first=await transfer.command({command:'media.chunk',transferId:key,requestId:'a',secret,index:0,offset:0});
  assert.equal(first.media.length,MEDIA_CHUNK_BYTES);
  await assert.rejects(transfer.command({command:'media.chunk',transferId:key,requestId:'a',secret,index:0,offset:0}),{code:'MEDIA_ORDER'});
  await transfer.command({command:'media.chunk',transferId:key,requestId:'a',secret,index:1,offset:MEDIA_CHUNK_BYTES});
  assert.deepEqual((await transfer.command({command:'media.finish',transferId:key,requestId:'a',secret})).media,{completed:true});
  await assert.rejects(transfer.command({command:'media.chunk',transferId:key,requestId:'a',secret,index:2,offset:data.length}),{code:'MEDIA_DENIED'});
  transfer.close();
});

test('Phase 9: Cloud transfer corrupted source checksum fails before any binary frame',async()=>{
  const data=await createImage();
  const result={artifactId,mimeType:'image/png',size:data.length,sha256:'f'.repeat(64),imageBytesDelivered:false};
  const frames=[];
  const bridge=createCloudMediaBridge({instanceId:'inst_p9',readImage:async()=>({data,metadata:{mimeType:'image/png'}}),
    send:async frame=>frames.push(frame)});
  assert.equal(bridge.acceptCapabilities({instanceId:'inst_p9',version:1,
    features:['image-content','transfer-chunks-v1'],maxChunkBytes:MEDIA_CHUNK_BYTES}),true);
  await assert.rejects(bridge.sendImage('browser_screenshot',result,'req-p9'),{code:'MEDIA_INVALID'});
  assert.equal(frames.some(frame=>frame.type==='media.transfer.chunk'),false);
  bridge.stop();
});
