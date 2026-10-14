import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveCloudBrowserIdentity } from '../../src/browser/identity.js';
import { createBrowserStorage } from '../../src/browser/storage.js';
import { createBrowserSessionEngine } from '../../src/browser/session-engine.js';

const credential=(token,account='alice@example.com',accountId='acct_alice')=>({
  cloudUrl:'https://bdxa.example.com',deviceId:'device_1',deviceToken:token,
  account,...(accountId?{accountId}:{})
});
const cookie=[{name:'session',value:'kept-on-device',domain:'example.org',path:'/',expires:2000000000}];
async function fixture(t){
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'bdxa-f04-')));
  const root=path.join(base,'workspace');const home=path.join(base,'home');
  await mkdir(root);
  const engines=[];
  t.after(async()=>{for(const engine of engines)await engine.closeAll().catch(()=>undefined);await rm(base,{recursive:true,force:true});});
  const makeStore=(id,legacy)=>createBrowserStorage({workspaceRoot:root,namespace:'cloud',principalId:id,
    legacyPrincipalId:legacy??null,homeDirectory:home});
  const launches=[];
  const browser={
    async launchPersistentContext(dir){
      launches.push(dir);
      let saved=[];
      return {pages:()=>[{url:()=> 'about:blank'}],
        async addCookies(items){saved=structuredClone(items);},
        async cookies(){return saved;},
        async close(){}
      };
    }
  };
  const makeEngine=(ident,extra={})=>{
    const engine=createBrowserSessionEngine({workspaceRoot:root,namespace:'cloud',
      instanceId:'inst_f04',principalId:ident.scopePrincipalId,
      storagePrincipalId:ident.storagePrincipalId,
      legacyStoragePrincipalId:ident.legacyStoragePrincipalId,
      persistentConsent:async()=>true,homeDirectory:home,chromium:browser,...extra});
    engines.push(engine);
    return engine;
  };
  const scope=ident=>({instanceId:'inst_f04',principalId:ident.scopePrincipalId});
  return {base,root,home,makeStore,makeEngine,scope,launches};
}
test('F04: stable account identity survives rotated device token without reusing active session scope',()=>{
  const a=resolveCloudBrowserIdentity(credential('token-old'));
  const b=resolveCloudBrowserIdentity(credential('token-new'));
  assert.notEqual(a.scopePrincipalId,b.scopePrincipalId);
  assert.equal(a.storagePrincipalId,b.storagePrincipalId);
  assert.equal(a.legacyStoragePrincipalId,a.scopePrincipalId);
  assert.equal(b.legacyStoragePrincipalId,b.scopePrincipalId);
  assert.ok(!a.storagePrincipalId.includes('token'));
  const other=resolveCloudBrowserIdentity(credential('token-new','bob@example.com','acct_bob'));
  assert.notEqual(a.storagePrincipalId,other.storagePrincipalId);
  const tenant=resolveCloudBrowserIdentity({...credential('token-new'),cloudUrl:'https://different.example.com'});
  assert.notEqual(a.storagePrincipalId,tenant.storagePrincipalId);
  const emailOnly=resolveCloudBrowserIdentity(credential('email-token-one','ALICE@EXAMPLE.COM',null));
  const emailRotated=resolveCloudBrowserIdentity(credential('email-token-two','alice@example.com',null));
  assert.equal(emailOnly.storagePrincipalId,emailRotated.storagePrincipalId,
    'Earlier email-only credentials must have rotation-stable profile ownership');
  assert.notEqual(emailOnly.scopePrincipalId,emailRotated.scopePrincipalId);
  const old=resolveCloudBrowserIdentity(credential('token-old',null,null));
  const rotated=resolveCloudBrowserIdentity(credential('token-new',null,null));
  assert.notEqual(old.storagePrincipalId,rotated.storagePrincipalId);
  assert.equal(old.storagePrincipalId,old.scopePrincipalId);
  assert.equal(old.legacyStoragePrincipalId,null);
});

test('F04: consented legacy current-token profile migrates atomically into stable owner and survives rotation',async t=>{
  const f=await fixture(t);const a=resolveCloudBrowserIdentity(credential('old-token'));
  const old=f.makeStore(a.scopePrincipalId);
  await old.saveProfileState('approved',cookie);
  const original=await old.profileDirectory('approved');
  const source=path.join(original.dataDirectory,'chromium-localstorage');
  await writeFile(source,'persisted-by-chromium');
  const unrelated=path.join(f.root,'user-file.txt');await writeFile(unrelated,'keep');
  const eng=f.makeEngine(a);
  const s=await eng.open({scope:f.scope(a),kind:'persistent',profileName:'approved',confirmPersistent:true});
  const current=f.makeStore(a.storagePrincipalId);
  const stable=await current.profileDirectory('approved');
  assert.equal(f.launches.at(-1),stable.dataDirectory);
  assert.notEqual(stable.dataDirectory,original.dataDirectory);
  assert.equal((await current.readProfileState('approved'))[0].value,cookie[0].value);
  assert.equal(await readFile(path.join(stable.dataDirectory,'chromium-localstorage'),'utf8'),'persisted-by-chromium');
  assert.equal(existsSync(original.directory),false,'Old profile directory is moved, never copied to unrelated owners');
  await eng.closeSession(s.sessionId,{scope:f.scope(a)});
  const rotated=resolveCloudBrowserIdentity(credential('new-token'));
  const next=f.makeEngine(rotated);
  const again=await next.open({scope:f.scope(rotated),kind:'persistent',profileName:'approved',confirmPersistent:true});
  assert.equal(f.launches.at(-1),stable.dataDirectory);
  assert.equal((await current.readProfileState('approved'))[0].value,cookie[0].value);
  assert.equal(await readFile(unrelated,'utf8'),'keep');
  await next.closeSession(again.sessionId,{scope:f.scope(rotated)});
});

test('F04: no consent never migrates old browser profile, and unknown previous token is not guessed',async t=>{
  const f=await fixture(t);const id=resolveCloudBrowserIdentity(credential('original'));
  const old=f.makeStore(id.scopePrincipalId);
  await old.saveProfileState('private',cookie);
  const oldPath=(await old.profileDirectory('private')).directory;
  const rejected=f.makeEngine(id,{persistentConsent:async()=>false});
  await assert.rejects(rejected.open({scope:f.scope(id),kind:'persistent',profileName:'private',confirmPersistent:true}),{code:'BROWSER_CONSENT_REQUIRED'});
  assert.equal(existsSync(oldPath),true);
  const rotated=resolveCloudBrowserIdentity(credential('replacement'));
  const newEngine=f.makeEngine(rotated);
  const session=await newEngine.open({scope:f.scope(rotated),kind:'persistent',profileName:'private',confirmPersistent:true});
  assert.equal(existsSync(oldPath),true,'Unknown old-token profile remains untouched after rotation');
  assert.equal(await f.makeStore(rotated.storagePrincipalId).readProfileState('private'),null);
  await newEngine.closeSession(session.sessionId,{scope:f.scope(rotated)});
});

test('F04: migration refuses locked, symlinked or pre-existing stable profile without deleting legacy data',async t=>{
  const f=await fixture(t);const id=resolveCloudBrowserIdentity(credential('legacy'));
  const old=f.makeStore(id.scopePrincipalId);
  await old.saveProfileState('locked',cookie);
  const original=await old.profileDirectory('locked');
  const release=await old.acquireProfileLock('locked');
  const engine=f.makeEngine(id);
  await assert.rejects(engine.open({scope:f.scope(id),kind:'persistent',profileName:'locked',confirmPersistent:true}),
    {code:'BROWSER_PROFILE_IN_USE'});
  assert.equal(existsSync(original.directory),true);
  await release();
  const external=path.join(f.root,'outside.txt');await writeFile(external,'keep-safe');
  await symlink(external,path.join(original.dataDirectory,'unsafe-link'));
  await assert.rejects(engine.open({scope:f.scope(id),kind:'persistent',profileName:'locked',confirmPersistent:true}),
    {code:'BROWSER_UNSAFE_PATH'});
  assert.equal(await readFile(external,'utf8'),'keep-safe');
  await rm(path.join(original.dataDirectory,'unsafe-link'));
  const stable=f.makeStore(id.storagePrincipalId);
  await stable.saveProfileState('locked',[{...cookie[0],value:'new-owner-wins'}]);
  const opened=await engine.open({scope:f.scope(id),kind:'persistent',profileName:'locked',confirmPersistent:true});
  assert.equal((await stable.readProfileState('locked'))[0].value,'new-owner-wins');
  assert.equal(existsSync(original.directory),true,'Existing destination is never overwritten');
  await engine.closeSession(opened.sessionId,{scope:f.scope(id)});
});

test('F04: another account on same device/workspace cannot access stable owner profile',async t=>{
  const f=await fixture(t);
  const alice=resolveCloudBrowserIdentity(credential('token-a'));
  const bob=resolveCloudBrowserIdentity(credential('token-b','bob@example.com','bob'));
  const a=f.makeStore(alice.storagePrincipalId);const b=f.makeStore(bob.storagePrincipalId);
  await a.saveProfileState('shared',cookie);
  assert.equal(await b.readProfileState('shared'),null);
  assert.notEqual((await a.profileDirectory('shared')).dataDirectory,(await b.profileDirectory('shared')).dataDirectory);
  const bobEngine=f.makeEngine(bob);
  const opened=await bobEngine.open({scope:f.scope(bob),kind:'persistent',profileName:'shared',confirmPersistent:true});
  assert.equal(existsSync((await a.profileDirectory('shared')).dataDirectory),true);
  assert.equal(await b.readProfileState('shared')?.then(x=>x?.[0]?.value),undefined);
  await bobEngine.closeSession(opened.sessionId,{scope:f.scope(bob)});
});


test('F04 real Chromium: explicitly consented previous-token profile migrates and keeps cookie after rotating token',{timeout:60000},async t=>{
  if(!existsSync(chromium.executablePath()))return t.skip('Chromium not installed');
  const f=await fixture(t);
  const old=resolveCloudBrowserIdentity(credential('browser-token-old'));
  const oldEngine=createBrowserSessionEngine({workspaceRoot:f.root,namespace:'cloud',
    instanceId:'inst_f04',principalId:old.scopePrincipalId,
    homeDirectory:f.home,persistentConsent:async()=>true,maxSessions:1});
  t.after(()=>oldEngine.closeAll());
  const first=await oldEngine.open({scope:f.scope(old),kind:'persistent',profileName:'real-browser',confirmPersistent:true});
  await oldEngine.withSession(first.sessionId,async({context})=>{
    await context.addCookies([{name:'f04_token',value:'session-preserved',
      domain:'example.org',path:'/',expires:2000000000,httpOnly:true}]);
  },{scope:f.scope(old)});
  await oldEngine.closeSession(first.sessionId,{scope:f.scope(old)});
  const legacy=f.makeStore(old.scopePrincipalId);
  const oldPath=(await legacy.profileDirectory('real-browser')).directory;
  const rotated=resolveCloudBrowserIdentity(credential('browser-token-new'));
  // The old token is available only at this migration step. Future rotations
  // already reuse stable storage without requiring access to the old token.
  const stableEngine=createBrowserSessionEngine({workspaceRoot:f.root,namespace:'cloud',
    instanceId:'inst_f04',principalId:old.scopePrincipalId,
    storagePrincipalId:old.storagePrincipalId,legacyStoragePrincipalId:old.scopePrincipalId,
    homeDirectory:f.home,persistentConsent:async()=>true,maxSessions:1});
  t.after(()=>stableEngine.closeAll());
  const migrated=await stableEngine.open({scope:f.scope(old),kind:'persistent',profileName:'real-browser',confirmPersistent:true});
  await stableEngine.withSession(migrated.sessionId,async({context})=>{
    assert.equal((await context.cookies('https://example.org')).find(x=>x.name==='f04_token')?.value,'session-preserved');
  },{scope:f.scope(old)});
  await stableEngine.closeSession(migrated.sessionId,{scope:f.scope(old)});
  assert.equal(existsSync(oldPath),false);
  const nextEngine=createBrowserSessionEngine({workspaceRoot:f.root,namespace:'cloud',
    instanceId:'inst_f04',principalId:rotated.scopePrincipalId,
    storagePrincipalId:rotated.storagePrincipalId,legacyStoragePrincipalId:rotated.scopePrincipalId,
    homeDirectory:f.home,persistentConsent:async()=>true,maxSessions:1});
  t.after(()=>nextEngine.closeAll());
  const second=await nextEngine.open({scope:f.scope(rotated),kind:'persistent',profileName:'real-browser',confirmPersistent:true});
  await nextEngine.withSession(second.sessionId,async({context})=>{
    assert.equal((await context.cookies('https://example.org')).find(x=>x.name==='f04_token')?.value,'session-preserved');
  },{scope:f.scope(rotated)});
  await nextEngine.closeSession(second.sessionId,{scope:f.scope(rotated)});
});
