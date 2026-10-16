import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createArtifactCache } from '../../src/cache/store.js';
import { resolveCloudCachePrincipal } from '../../src/cache/principal.js';
import { createRuntime } from '../../src/core/runtime.js';
import { normalizePolicy } from '../../src/permissions/policy.js';

const sharp = createRequire(import.meta.url)('sharp');

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'bdxa-f03-'));
  const workspace = path.join(base,'workspace');
  const homeDirectory = path.join(base,'device');
  await mkdir(workspace);
  const created=[];
  const makeCache = (principalId, namespace = 'cloud') => {
    const cache=createArtifactCache({workspaceRoot:workspace, namespace,
      homeDirectory, ...(principalId ? {principalId} : {})});
    created.push(cache);
    return cache;
  };
  const policy=normalizePolicy({categories:{imageRead:'allow',imageSave:'allow',cacheManage:'allow',browserCapture:'allow'}});
  const makeRuntime = (principalId, cachePrincipalId, cache) => {
    const imageCache=cache ?? makeCache();
    const runtime=createRuntime({root:workspace,namespace:'cloud',instanceId:'inst_f03',
      principalId,cachePrincipalId,imageCache,policy,interactive:false});
    created.push(runtime);
    return runtime;
  };
  t.after(async()=>{
    for(const item of created.reverse()) {
      if(item.stop) await item.stop().catch(()=>undefined);
      else item.close();
    }
    await rm(base,{recursive:true,force:true});
  });
  return {base,workspace,homeDirectory,makeCache,makeRuntime};
}
const credentials = (account, deviceToken, more={}) => ({
  cloudUrl:'https://bdxa.example.com',deviceId:'same-device',deviceToken,
  account,...more
});
const png=()=>sharp({create:{width:16,height:12,channels:3,background:'#345678'}}).png().toBuffer();

test('F03: authenticated account key survives token rotation and email case changes; tenant and account changes isolate',()=>{
  const userId='stable-user-id-9';
  const old=resolveCloudCachePrincipal(credentials('Case@Example.com','token-one',{accountId:userId}));
  const rotated=resolveCloudCachePrincipal(credentials('case@example.com','token-two',{accountId:userId}));
  assert.equal(old,rotated);
  assert.equal(resolveCloudCachePrincipal(credentials('CASE@example.com','token-one')),
    resolveCloudCachePrincipal(credentials('case@example.com','token-two')));
  assert.notEqual(old,resolveCloudCachePrincipal(credentials('other@example.com','token-one',{accountId:'different'})));
  assert.notEqual(old,resolveCloudCachePrincipal({...credentials('Case@Example.com','token-one',{accountId:userId}),cloudUrl:'https://other.example.com'}));
  assert.match(old,/^cloud_cache_[0-9a-f]{64}$/);
  assert.ok(!old.includes('token')&&!old.includes('Case'));
  const fallback=resolveCloudCachePrincipal(credentials(null,'fallback-one'));
  assert.notEqual(fallback,resolveCloudCachePrincipal(credentials(null,'fallback-two')),
    'Legacy credentials without account cannot safely share a cache after token rotation');
  assert.throws(()=>resolveCloudCachePrincipal({cloudUrl:'https://bdxa.example.com',deviceId:'device'}));
});

test('F03: same device/workspace/namespace but different signed-in accounts cannot list, read, save, remove or clear each other',async t=>{
  const f=await fixture(t);
  const alice=resolveCloudCachePrincipal(credentials('alice@example.com','a',{accountId:'alice-id'}));
  const bob=resolveCloudCachePrincipal(credentials('bob@example.com','b',{accountId:'bob-id'}));
  const ra=f.makeRuntime('browser-alice',alice);
  const rb=f.makeRuntime('browser-bob',bob);
  const screenshot=await ra.services.__storeScreenshot(await png());
  const imported=await ra.services.__storeScreenshot(await png());
  const aId=(await ra.services.__artifactRequiresCapture(screenshot.artifactId));
  assert.equal(aId,true);
  const ownerA=(await ra.services.__artifactRequiresCapture(imported.artifactId));
  assert.equal(ownerA,true);
  assert.deepEqual((await rb.dispatch('list_cached_assets',{})).assets,[]);
  await assert.rejects(rb.dispatch('get_cached_image',{artifactId:screenshot.artifactId}),/Artifact not found/);
  await assert.rejects(rb.dispatch('get_image_info',{artifactId:imported.artifactId}),/Artifact not found/);
  await assert.rejects(rb.dispatch('save_cached_image',{artifactId:screenshot.artifactId,destinationPath:'leaked.png'}),/Artifact not found/);
  assert.deepEqual(await rb.dispatch('delete_cached_asset',{artifactId:screenshot.artifactId}),{deleted:false});
  await rb.dispatch('clear_cache',{});
  assert.equal((await ra.dispatch('get_cached_image',{artifactId:screenshot.artifactId})).mimeType,'image/png');
  assert.equal((await ra.dispatch('get_cached_image',{artifactId:imported.artifactId})).mimeType,'image/png');
  const cacheAlice=f.makeCache(alice);
  const cacheBob=f.makeCache(bob);
  assert.notEqual((await cacheAlice.identity()).ownerKey,(await cacheBob.identity()).ownerKey);
  assert.equal((await cacheAlice.get(screenshot.artifactId)).metadata.kind,'screenshot');
});

test('F03: same account survives agent restart and token rotation, including pre-existing temporary artifacts',async t=>{
  const f=await fixture(t);
  const account='account-immutable';
  const first=resolveCloudCachePrincipal(credentials('first@example.com','token1',{accountId:account}));
  const second=resolveCloudCachePrincipal(credentials('second@example.com','token2',{accountId:account}));
  assert.equal(first,second);
  const one=f.makeRuntime('token-dependent-browser-one',first);
  const screenshot=await one.services.__storeScreenshot(await png());
  await one.stop();
  const two=f.makeRuntime('token-dependent-browser-two',second);
  assert.equal((await two.dispatch('get_cached_image',{artifactId:screenshot.artifactId})).mimeType,'image/png');
  assert.equal((await two.dispatch('save_cached_image',{artifactId:screenshot.artifactId,destinationPath:'approved.png'})).saved,true);
});

test('F03 migration: legacy shared cache cannot be automatically inherited or deleted by authenticated accounts',async t=>{
  const f=await fixture(t);
  const unscoped=f.makeCache();
  const legacy=await unscoped.put({data:await png(),kind:'image',origin:'import',mimeType:'image/png'});
  const oldIdentity=await unscoped.identity();
  const owner=path.join(f.homeDirectory,'cache','v1','owners',oldIdentity.ownerKey);
  const metadata=await readFile(path.join(owner,'meta',legacy.id+'.json'));
  const user=f.makeRuntime('browser-user',resolveCloudCachePrincipal(credentials('a@example.com','tokenA')));
  await assert.rejects(user.dispatch('get_cached_image',{artifactId:legacy.id}),/Artifact not found/);
  assert.deepEqual((await user.dispatch('list_cached_assets',{})).assets,[]);
  await user.dispatch('clear_cache',{});
  assert.deepEqual(await readFile(path.join(owner,'meta',legacy.id+'.json')),metadata,
    'Existing unscoped artifacts must not be moved or silently deleted');
  assert.ok((await stat(path.join(owner,'data',legacy.id+'.bin'))).isFile());
  assert.equal((await unscoped.get(legacy.id)).metadata.id,legacy.id);
});

test('F03: pre-initialized unscoped caches and cross-account cache injection fail closed',async t=>{
  const f=await fixture(t);
  const legacy=f.makeCache();
  await legacy.identity();
  const stable=resolveCloudCachePrincipal(credentials('one@example.com','tokenOne'));
  assert.throws(()=>f.makeRuntime('browser-user',stable,legacy),/initialized artifact cache owner/);
  const a=f.makeCache(stable);
  f.makeRuntime('user-a',stable,a);
  const other=resolveCloudCachePrincipal(credentials('two@example.com','tokenTwo'));
  assert.throws(()=>f.makeRuntime('user-b',other,a),/another principal/);
});


test('F03: global quota cannot evict a different authenticated account cache',async t=>{
  const f=await fixture(t);
  const alice=resolveCloudCachePrincipal(credentials('alice@example.com','one',{accountId:'alice'}));
  const bob=resolveCloudCachePrincipal(credentials('bob@example.com','two',{accountId:'bob'}));
  const a=createArtifactCache({workspaceRoot:f.workspace,namespace:'cloud',homeDirectory:f.homeDirectory,
    principalId:alice,quotaBytes:12,maxArtifactBytes:10});
  const b=createArtifactCache({workspaceRoot:f.workspace,namespace:'cloud',homeDirectory:f.homeDirectory,
    principalId:bob,quotaBytes:12,maxArtifactBytes:10});
  t.after(()=>{a.close();b.close();});
  const item=await a.put({data:Buffer.alloc(8,11)});
  await assert.rejects(b.put({data:Buffer.alloc(8,22)}),{code:'CACHE_QUOTA_EXCEEDED'});
  assert.deepEqual((await a.get(item.id)).data,Buffer.alloc(8,11));
  assert.equal((await b.list()).length,0);
});
