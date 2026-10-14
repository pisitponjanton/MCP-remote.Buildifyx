import { createHash } from 'node:crypto';
import { MEDIA_CHUNK_BYTES, mediaError } from './protocol.js';

const LIMIT_BYTES=4*1024*1024;
const IDLE_MS=30_000;
const MAX_QUEUE=64;
const IMPORT_TYPES=new Set(['media.import.open','media.import.chunk','media.import.complete','media.import.cancel']);
const VALID_MIME=new Set(['image/png','image/jpeg','image/webp']);
const SHA=/^[0-9a-f]{64}$/;
const ARTIFACT=/^art_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isId=v=>typeof v==='string' && v.length>0 && v.length<=128;
function validIdentity(m,id){
  return m && m.instanceId===id && isId(m.requestId) && isId(m.transferId);
}
function digest(data){return createHash('sha256').update(data).digest('hex');}
function mimeOf(data){
  if(data.length>=8 && data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(data.length>=3 && data[0]===255 && data[1]===216 && data[2]===255)return 'image/jpeg';
  if(data.length>=12 && data.toString('ascii',0,4)==='RIFF' && data.toString('ascii',8,12)==='WEBP')return 'image/webp';
  return null;
}
function fail(code){return mediaError(code,code);}

export function createCloudImageImportReceiver({ instanceId, send, storeImage,
  clearImages=()=>{}, canImport=()=>false, current=()=>true, now=()=>Date.now() }){
  if(typeof storeImage!=='function' || typeof send!=='function')throw new TypeError('Import receiver requires callbacks');
  let enabled=false, pending=null, serial=Promise.resolve(), queued=0, generation=0;
  const timer=setInterval(()=>{
    if(pending && pending.expiresAt<=now())clear();
  },5000);
  timer.unref?.();
  function clear(){
    if(pending)pending.data.fill(0);
    pending=null;
  }
  function reset(){
    generation++;
    enabled=false;
    clear();
    clearImages();
  }
  async function safeReply(type,m,data={},source,epoch=generation){
    if(epoch!==generation || !current(source))return;
    await send({type,instanceId,requestId:m.requestId,transferId:m.transferId,...data});
  }
  async function handle(m,source,epoch){
    if(epoch!==generation || !validIdentity(m,instanceId)||!current(source))return;
    try{
      if(m.type==='media.import.cancel'){
        if(pending?.requestId===m.requestId && pending.transferId===m.transferId)clear();
        return;
      }
      if(!enabled)throw fail('UNSUPPORTED_CAPABILITY');
      if(!await canImport() || epoch!==generation || !current(source))throw fail('MEDIA_IMPORT_PERMISSION_REQUIRED');
      if(m.type==='media.import.open'){
        if(pending)throw fail('MEDIA_IMPORT_BUSY');
        if(m.version!==1 || m.chunkBytes!==MEDIA_CHUNK_BYTES || !Number.isInteger(m.size) ||
          m.size<1 || m.size>LIMIT_BYTES || !SHA.test(m.sha256) || !VALID_MIME.has(m.mimeType)) {
          throw fail('MEDIA_IMPORT_INVALID');
        }
        pending={requestId:m.requestId,transferId:m.transferId,version:1,size:m.size,
          mimeType:m.mimeType,sha256:m.sha256,data:Buffer.alloc(m.size),offset:0,index:0,
          expiresAt:now()+IDLE_MS};
        await safeReply('media.import.accept',m,{accepted:true},source,epoch);
        return;
      }
      const transfer=pending;
      if(!transfer||m.requestId!==transfer.requestId||m.transferId!==transfer.transferId
        ||transfer.expiresAt<=now())throw fail('MEDIA_IMPORT_INVALID');
      transfer.expiresAt=now()+IDLE_MS;
      if(m.type==='media.import.chunk'){
        if(!Number.isSafeInteger(m.index)||m.index!==transfer.index ||
          !Number.isSafeInteger(m.offset)||m.offset!==transfer.offset ||
          !Number.isInteger(m.length)||m.length<1||m.length>MEDIA_CHUNK_BYTES ||
          typeof m.data!=='string'||m.data.length>4*Math.ceil(MEDIA_CHUNK_BYTES/3) ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(m.data))throw fail('MEDIA_IMPORT_INVALID');
        const bytes=Buffer.from(m.data,'base64');
        if(bytes.length!==m.length || bytes.toString('base64')!==m.data
          || transfer.offset+bytes.length>transfer.size)throw fail('MEDIA_IMPORT_INVALID');
        bytes.copy(transfer.data,transfer.offset);
        bytes.fill(0);
        transfer.offset+=m.length;
        transfer.index++;
        await safeReply('media.import.ack',m,{index:m.index,offset:transfer.offset},source,epoch);
        return;
      }
      if(m.type==='media.import.complete'){
        if(m.size!==transfer.size||m.sha256!==transfer.sha256||transfer.offset!==transfer.size
          ||digest(transfer.data)!==transfer.sha256||mimeOf(transfer.data)!==transfer.mimeType)throw fail('MEDIA_IMPORT_INVALID');
        if(!await canImport()||epoch!==generation||!current(source))throw fail('MEDIA_IMPORT_PERMISSION_REQUIRED');
        const stored=await storeImage(transfer.data);
        if(epoch!==generation||!current(source)||!await canImport()){
          clearImages();
          throw fail('MEDIA_IMPORT_PERMISSION_REQUIRED');
        }
        if(!ARTIFACT.test(stored?.artifactId)||stored?.sha256!==transfer.sha256)
          throw fail('MEDIA_IMPORT_INVALID');
        // Safe even if Agent permissions were revoked asynchronously during
        // decoder work: the storage callback rechecks policy at commit.
        if(epoch!==generation||!await canImport()||!current(source)){
          clearImages();
          throw fail('MEDIA_IMPORT_PERMISSION_REQUIRED');
        }
        const reply={size:transfer.size,sha256:transfer.sha256,artifactId:stored.artifactId};
        clear();
        await safeReply('media.import.received',m,reply,source,epoch);
        return;
      }
      throw fail('MEDIA_IMPORT_INVALID');
    }catch(e){
      const code=typeof e?.code==='string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(e.code)
        ? e.code:'MEDIA_IMPORT_INVALID';
      // A rejected import may never leave its bytes in a reusable session.
      if(pending?.requestId===m.requestId && pending.transferId===m.transferId)clear();
      await safeReply('media.import.error',m,{code},source,epoch).catch(()=>undefined);
    }
  }
  function receive(m,source){
    if(!IMPORT_TYPES.has(m?.type))return false;
    if(!current(source))return true;
    if(queued>=MAX_QUEUE) {
      clear();
      void safeReply('media.import.error',m,{code:'MEDIA_IMPORT_BUSY'},source).catch(()=>undefined);
      return true;
    }
    queued++;
    const epoch=generation;
    serial=serial.then(()=>epoch===generation ? handle(m,source,epoch) : undefined)
      .catch(()=>{ if(epoch===generation)clear(); }).finally(()=>{queued--;});
    return true;
  }
  function accept(allowed){enabled=Boolean(allowed);if(!enabled){generation++;clear();}}
  function stop(){reset();clearInterval(timer);}
  return {receive,accept,reset,stop,get active(){return Boolean(pending);}};
}
