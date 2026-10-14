import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createRuntime } from '../../src/core/runtime.js';
import { normalizePolicy } from '../../src/permissions/policy.js';

const sharp = createRequire(import.meta.url)('sharp');

async function fixture(t, categories={}, interactive=false) {
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'bdxa-r03-')));
  const root=path.join(base,'workspace');
  await mkdir(root);
  const bytes=await sharp({create:{width:18,height:14,channels:3,background:'#123456'}}).png().toBuffer();
  await writeFile(path.join(root,'source.png'),bytes);
  const runtime=createRuntime({root,interactive,namespace:'local',
    policy:normalizePolicy({categories:{imageRead:'allow',imageSave:'allow',outsideRoot:'deny',...categories}})});
  t.after(async()=>{await runtime.stop().catch(()=>undefined);await rm(base,{recursive:true,force:true});});
  return {runtime,root,base,bytes};
}
async function pendingApproval(runtime,category){
  for(let i=0;i<150;i++){
    const item=runtime.approvalQueue.getPending().find(x=>x.category===category);
    if(item)return item;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('Expected permission approval for '+category);
}
async function approve(runtime,category) {
  const item=await pendingApproval(runtime,category);
  assert.equal(runtime.approvalQueue.resolve(item.id,{action:'allow',remember:null}),true);
  return item;
}
const args=(destinationPath='copied.png')=>({path:'source.png',destinationPath});

test('R03: imageRead Deny + imageSave Allow cannot read source or create image output',async t=>{
  const f=await fixture(t,{imageRead:'deny',imageSave:'allow'});
  await assert.rejects(f.runtime.dispatch('save_image',args()),e=>
    e.code==='PERMISSION_DENIED' && e.details?.category==='imageRead');
  assert.equal(existsSync(path.join(f.root,'copied.png')),false);
  const categories=f.runtime.eventBus.getHistory()
    .filter(e=>e.type==='permission.evaluated'&&e.tool==='save_image').map(e=>e.category);
  assert.deepEqual(categories,['imageRead','imageSave']);
});

test('R03: imageSave Deny still rejects even if imageRead Allow',async t=>{
  const f=await fixture(t,{imageRead:'allow',imageSave:'deny'});
  await assert.rejects(f.runtime.dispatch('save_image',args()),e=>
    e.code==='PERMISSION_DENIED'&&e.details?.category==='imageSave');
  assert.equal(existsSync(path.join(f.root,'copied.png')),false);
});

test('R03: imageRead Ask requires independent approval even when imageSave Allow',async t=>{
  const f=await fixture(t,{imageRead:'ask',imageSave:'allow'},true);
  const saved=f.runtime.dispatch('save_image',args());
  const approval=await pendingApproval(f.runtime,'imageRead');
  assert.equal(existsSync(path.join(f.root,'copied.png')),false);
  assert.equal(approval.evaluation.category,'imageRead');
  await approve(f.runtime,'imageRead');
  assert.equal((await saved).saved,true);
  assert.deepEqual(await readFile(path.join(f.root,'copied.png')),f.bytes);
});

test('R03: imageRead Ask + imageSave Ask prompts both categories independently',async t=>{
  const f=await fixture(t,{imageRead:'ask',imageSave:'ask'},true);
  const saved=f.runtime.dispatch('save_image',args());
  const source=await pendingApproval(f.runtime,'imageRead');
  assert.equal(source.category,'imageRead');
  await approve(f.runtime,'imageRead');
  const destination=await pendingApproval(f.runtime,'imageSave');
  assert.equal(destination.category,'imageSave');
  assert.equal(existsSync(path.join(f.root,'copied.png')),false);
  await approve(f.runtime,'imageSave');
  assert.equal((await saved).saved,true);
  assert.deepEqual(await readFile(path.join(f.root,'copied.png')),f.bytes);
});

test('R03: revoke source imageRead Allow->Ask while waiting for imageSave Ask, then approve save: no file',async t=>{
  const f=await fixture(t,{imageRead:'allow',imageSave:'ask'},true);
  const pending=f.runtime.dispatch('save_image',args());
  await pendingApproval(f.runtime,'imageSave');
  await f.runtime.policyManager.setCategory('imageRead','ask');
  await approve(f.runtime,'imageSave');
  await assert.rejects(pending,e=>e.code==='PERMISSION_DENIED'&&e.details?.category==='imageRead');
  assert.equal(existsSync(path.join(f.root,'copied.png')),false);
});

test('R03: revoke destination imageSave Allow->Deny while waiting for imageRead Ask: no file',async t=>{
  const f=await fixture(t,{imageRead:'ask',imageSave:'allow'},true);
  const pending=f.runtime.dispatch('save_image',args());
  await pendingApproval(f.runtime,'imageRead');
  await f.runtime.policyManager.setCategory('imageSave','deny');
  await approve(f.runtime,'imageRead');
  await assert.rejects(pending,e=>e.code==='PERMISSION_DENIED'&&e.details?.category==='imageSave');
  assert.equal(existsSync(path.join(f.root,'copied.png')),false);
});

test('R03: revocation at post-decode permission checkpoint stops a newly revoked source before save',async t=>{
  const f=await fixture(t);
  const original=f.runtime.services.save_image;
  let checkpoints=0;
  // Deterministic test-only simulated policy update at the async read/decode
  // boundary; this tests the live controller's checker, not a stub decision.
  f.runtime.services.save_image=(input,context)=>original(input,{
    ...context,
    assertStillAllowed(){
      checkpoints++;
      if(checkpoints===2)f.runtime.policyManager.get().categories.imageRead='ask';
      context.assertStillAllowed();
    }
  });
  await assert.rejects(f.runtime.dispatch('save_image',args()),e=>
    e.code==='PERMISSION_DENIED'&&e.details?.category==='imageRead');
  assert.ok(checkpoints>=2);
  assert.equal(existsSync(path.join(f.root,'copied.png')),false);
});

test('R03: revoke imageSave Allow->Ask just before exclusive destination creation: no new file',async t=>{
  const f=await fixture(t);
  const original=f.runtime.services.save_image;
  let checkpoints=0;
  f.runtime.services.save_image=(input,context)=>original(input,{
    ...context,
    assertStillAllowed(){
      checkpoints++;
      if(checkpoints===3)f.runtime.policyManager.get().categories.imageSave='ask';
      context.assertStillAllowed();
    }
  });
  await assert.rejects(f.runtime.dispatch('save_image',args()),e=>
    e.code==='PERMISSION_DENIED'&&e.details?.category==='imageSave');
  assert.ok(checkpoints>=3,'The final permission check must run immediately before creating the destination');
  assert.equal(existsSync(path.join(f.root,'copied.png')),false);
});

test('R03: both permissions Allow saves normally, preserving no-overwrite protection',async t=>{
  const f=await fixture(t);
  const result=await f.runtime.dispatch('save_image',args());
  assert.equal(result.saved,true);
  assert.deepEqual(await readFile(path.join(f.root,'copied.png')),f.bytes);
  await assert.rejects(f.runtime.dispatch('save_image',args()),{code:'IMAGE_EXISTS'});
});
