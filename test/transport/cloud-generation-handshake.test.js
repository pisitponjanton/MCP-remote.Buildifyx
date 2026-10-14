import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { createPolicyManager } from '../../src/permissions/manager.js';
import { loadPolicy } from '../../src/permissions/store.js';
import { createManagementHandler, MANAGEMENT_ACTIONS } from '../../src/services/management.js';
import { createCloudAgent } from '../../src/transport/cloud.js';

async function waitFor(predicate) {
  for(let i=0;i<180;i++){
    const result=predicate(); if(result)return result;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('Timed out waiting for handshake.');
}
async function server() {
  const wss=new WebSocketServer({port:0,path:'/agent'});
  await new Promise(resolve=>wss.once('listening',resolve));
  const address=wss.address();
  const messages=[];
  wss.on('connection',socket=>{
    socket.on('message',raw=>{
      try {messages.push(JSON.parse(raw.toString()))}catch{}
    });
  });
  return {wss,messages,cloudUrl:`http://127.0.0.1:${address.port}`,
    close:()=>new Promise(resolve=>wss.close(resolve))};
}
function makeAgent(cloudUrl,runtime,handler) {
  return createCloudAgent({
    cloudUrl,
    credentials:{deviceId:'fixture-device',deviceToken:'fixture-token'},
    runtime,managementHandler:handler,
    managementCapabilities:MANAGEMENT_ACTIONS,
    manifest:{count:0,hash:'fixture',manifestVersion:1},
    version:'0.4.0',instance:{instanceId:'fixture-instance',name:'fixture',path:'/tmp/fixture',mode:'foreground'},
    deviceInfo:{platform:process.platform,arch:process.arch},
    reconnect:false,heartbeatMs:60000
  });
}

test('device.ready advertises cross-process fence only after durable generation claim',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bdxa-cloud-handshake-'));
  const filePath=path.join(dir,'policy.json');
  const fixture=await server();
  const policyManager=createPolicyManager(await loadPolicy(filePath),{filePath});
  const handler=createManagementHandler({policyManager,instance:{instanceId:'fixture-instance',name:'fixture',path:dir,mode:'foreground'},getConnectionState:()=>({status:'connected'})});
  const agent=makeAgent(fixture.cloudUrl,{policyManager,dispatch:async()=>null,cancel(){}},handler);
  try {
    agent.connect();
    const ready=await waitFor(()=>fixture.messages.find(x=>x.type==='device.ready'));
    assert.equal(ready.capabilities.permissionFencing,'policy-file-v1');
    assert.ok(ready.capabilities.actions.includes('permission.settled'));
    const marker=(await readFile(filePath+'.remote-generation','utf8')).trim();
    assert.match(marker,/^[0-9a-f-]{36}$/);
    assert.ok(marker.length>0);
    // Real management call against a disposable policy file, never user policy.
    const ws=[...fixture.wss.clients][0];
    ws.send(JSON.stringify({type:'management.call',requestId:'fixture-write',instanceId:'fixture-instance',action:'permission.set',arguments:{category:'browserRead',action:'deny'}}));
    const response=await waitFor(()=>fixture.messages.find(x=>x.requestId==='fixture-write'));
    assert.equal(response.type,'management.result');
    assert.equal((await loadPolicy(filePath)).categories.browserRead,'deny');
  } finally {
    await agent.stop().catch(()=>{});
    await fixture.close();
    await rm(dir,{recursive:true,force:true});
  }
});

test('failed durable generation claim does not advertise a false safe-fence capability',async()=>{
  const fixture=await server();
  const runtime={policyManager:{claimRemoteGeneration:async()=>{throw new Error('Fixture generation claim rejected')},get:()=>({categories:{}})},dispatch:async()=>null,cancel(){}};
  const agent=makeAgent(fixture.cloudUrl,runtime,async()=>({ok:true}));
  try {
    agent.connect();
    await waitFor(()=>agent.getState().status==='disconnected' || agent.getState().status==='revoked');
    assert.equal(fixture.messages.some(x=>x.type==='device.ready'),false);
  } finally {await agent.stop().catch(()=>{});await fixture.close()}
});
