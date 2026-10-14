import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadPolicy, savePolicy } from '../../src/permissions/store.js';
import { normalizePolicy } from '../../src/permissions/policy.js';

function startWorker(filePath) {
  const child=fork(fileURLToPath(new URL('./remote-generation-worker.mjs',import.meta.url)), [], {
    env:{...process.env,BDXA_FIXTURE_POLICY_PATH:filePath},
    stdio:['ignore','pipe','pipe','ipc']
  });
  let serial=0;
  const waiting=new Map();
  let readyResolve;
  const ready=new Promise(resolve=>{readyResolve=resolve});
  let errorLog='';
  child.stderr?.on('data',data=>{errorLog+=String(data)});
  child.on('message',msg=>{
    if(msg.event==='ready'){readyResolve();return}
    const item=waiting.get(msg.id);
    if(!item)return;
    if(msg.event==='locked'){item.entered?.();return}
    waiting.delete(msg.id);
    item.resolve(msg);
  });
  child.on('exit',code=>{
    for(const item of waiting.values())item.reject(new Error('Child exited early '+code+': '+errorLog));
    waiting.clear();
  });
  function request(action,extra={},onEntered){
    const id=++serial;
    return new Promise((resolve,reject)=>{
      waiting.set(id,{resolve,reject,entered:onEntered});
      child.send({id,action,...extra},e=>{
        if(!e)return;
        waiting.delete(id);
        reject(e);
      });
    });
  }
  return {ready,request,stop:()=>{child.kill();},process:child};
}

test('two independent Agent processes share one instance generation and reject old writes',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'bdxa-generation-multiprocess-'));
  const filePath=path.join(dir,'instance-policy.json');
  let oldProcess,newProcess;
  try{
    await savePolicy(normalizePolicy(),filePath);
    oldProcess=startWorker(filePath);
    newProcess=startWorker(filePath);
    await Promise.all([oldProcess.ready,newProcess.ready]);
    const oldToken=randomUUID(),newToken=randomUUID();
    assert.equal((await oldProcess.request('claim',{generation:oldToken})).ok,true);
    assert.equal((await oldProcess.request('write',{decision:'allow'})).value,'allow');
    assert.equal((await newProcess.request('claim',{generation:newToken})).ok,true);
    assert.equal((await newProcess.request('write',{decision:'ask'})).value,'ask');
    const stale=await oldProcess.request('write',{decision:'deny'});
    assert.equal(stale.ok,false);
    assert.equal(stale.code,'MANAGEMENT_SESSION_STALE');
    assert.equal((await loadPolicy(filePath)).categories.browserSensitive,'ask');
  }finally{
    oldProcess?.stop();newProcess?.stop();
    await rm(dir,{recursive:true,force:true});
  }
});

test('generation claim and atomic policy commit serialize across processes under the SAME lock',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'bdxa-generation-lock-'));
  const filePath=path.join(dir,'instance-policy.json');
  let oldProcess,newProcess;
  try{
    await savePolicy(normalizePolicy(),filePath);
    oldProcess=startWorker(filePath);newProcess=startWorker(filePath);
    await Promise.all([oldProcess.ready,newProcess.ready]);
    const oldToken=randomUUID(),newToken=randomUUID();
    assert.equal((await oldProcess.request('claim',{generation:oldToken})).ok,true);
    let unlockEntered;
    const entered=new Promise(resolve=>{unlockEntered=resolve});
    const oldWrite=oldProcess.request('hold',{decision:'allow'},unlockEntered);
    await entered;
    let claimed=false;
    const newClaim=newProcess.request('claim',{generation:newToken}).then(result=>{claimed=true;return result});
    await delay(100);
    assert.equal(claimed,false,'new generation cannot be claimed mid-commit');
    await oldProcess.request('release');
    assert.equal((await oldWrite).ok,true);
    assert.equal((await newClaim).ok,true);
    const latest=await newProcess.request('write',{decision:'ask'});
    assert.equal(latest.ok,true);
    const stale=await oldProcess.request('write',{decision:'deny'});
    assert.equal(stale.code,'MANAGEMENT_SESSION_STALE');
    assert.equal((await loadPolicy(filePath)).categories.browserSensitive,'ask');
  }finally{
    oldProcess?.stop();newProcess?.stop();
    await rm(dir,{recursive:true,force:true});
  }
});

test('old live lock cannot be evicted by aged mtime during generation claim', async()=>{
 const {utimes,open}=await import('node:fs/promises');
 const dir=await mkdtemp(path.join(tmpdir(),'bdxa-aged-lock-'));
 const filePath=path.join(dir,'instance-policy.json');
 let child;
 try {
  await savePolicy(normalizePolicy(),filePath);
  const lock=await open(filePath+'.lock','wx');
  try{
    const old=new Date(Date.now()-36000);await utimes(filePath+'.lock',old,old);
    child=startWorker(filePath);await child.ready;
    // The policy lock must fail closed, never be stolen from a live owner.
    const claim=child.request('claim',{generation:randomUUID()});
    const result=await claim;
    assert.equal(result.ok,false);
    assert.match(result.message,/Timed out waiting for permission policy lock/);
  }finally{await lock.close();await rm(filePath+'.lock',{force:true})}
 }finally{child?.stop();await rm(dir,{recursive:true,force:true})}
});

test('orphan-lock recovery requires old age and verified dead owner; never steals a live PID lock',async()=>{
 const {writeFile,utimes,stat}=await import('node:fs/promises');
 const {recoverOrphanedPolicyLock}=await import('../../src/permissions/store.js');
 const dir=await mkdtemp(path.join(tmpdir(),'bdxa-orphan-recovery-'));
 const filePath=path.join(dir,'instance-policy.json'),lockPath=filePath+'.lock';
 try {
   await savePolicy(normalizePolicy(),filePath);
   await writeFile(lockPath,JSON.stringify({pid:process.pid,createdAt:'fixture'})+'\n');
   await utimes(lockPath,new Date(Date.now()-60000),new Date(Date.now()-60000));
   assert.equal(await recoverOrphanedPolicyLock(filePath),false);
   await rm(lockPath);
   // Use a non-existent PID validated by kill(pid,0) instead of relying on
   // a guessed fixed integer (which could belong to a real process).
   let deadPid=900000;
   while(deadPid<999999){try{process.kill(deadPid,0);deadPid++}catch(e){if(e.code==='ESRCH')break;deadPid++}}
   assert.ok(deadPid<999999);
   await writeFile(lockPath,JSON.stringify({pid:deadPid,createdAt:'fixture'})+'\n');
   assert.equal(await recoverOrphanedPolicyLock(filePath),false,'fresh locks must never be removed');
   await utimes(lockPath,new Date(Date.now()-60000),new Date(Date.now()-60000));
   assert.equal(await recoverOrphanedPolicyLock(filePath),true);
   await assert.rejects(stat(lockPath),e=>e.code==='ENOENT');
 }finally{await rm(dir,{recursive:true,force:true})}
});
