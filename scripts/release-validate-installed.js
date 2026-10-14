import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { WebSocketServer } from 'ws';
import { requireIsolatedReleasePrefix } from './release-temp-prefix.js';
import { releaseNpmInvocation } from './release-npm-invocation.js';

const exec = promisify(execFile);
const packagesRoot = requireIsolatedReleasePrefix(process.argv[2]);
const tarball = path.join(packagesRoot,'buildifyx-desktop-agent-0.4.0.tgz');
const ws = new WebSocketServer({noServer:true});
const received = [];
const connections = [];
const server = createServer((req,res)=>{
  if (req.url === '/api/device/me') {
    if(req.headers.authorization !== 'Bearer test_device_secret') { res.writeHead(401);res.end('denied');return; }
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({device:{id:'test_device',status:'active'},credential:{expiresAt:null}}));
    return;
  }
  res.writeHead(404);res.end('missing');
});
server.on('upgrade',(req,socket,head)=>{
  if(req.url!=='/agent' || req.headers.authorization!=='Bearer test_device_secret') {
    socket.destroy();return;
  }
  ws.handleUpgrade(req,socket,head,client=>ws.emit('connection',client,req));
});
ws.on('connection',socket=>{connections.push(socket);socket.on('message',buf=>{
  try {received.push(JSON.parse(buf.toString()));}
  catch { }
});});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
// UNIX domain socket paths (notably macOS's 104-byte cap) require a short
// disposable home; Windows named-pipe tests use the native temporary root.
const fixtureTempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
const temporary=await mkdtemp(path.join(fixtureTempRoot, 'bdx-r11-'));
const origin='http://127.0.0.1:'+server.address().port;

const checks=[];
const run=(cmd,args,opts={})=>exec(cmd,args,{timeout:30000,maxBuffer:1024*1024,...opts});
const runNpm=(args,opts={})=>{
  const invocation=releaseNpmInvocation(args);
  return run(invocation.command,invocation.args,opts);
};
const script=(name)=>path.join(packagesRoot,name,'node_modules','@buildifyx','desktop-agent','src','cli.js');
const pkg=(name)=>path.join(packagesRoot,name,'node_modules','@buildifyx','desktop-agent','package.json');
async function childProgram(entry,args,env,cwd) {
  return await run(process.execPath,[entry,...args],{env,cwd});
}
async function smoke(version,entry,env,cwd) {
  const ver=await childProgram(entry,['--version'],env,cwd);
  assert.equal(ver.stdout.trim(),version);
  const before=await readFile(path.join(env.BUILDFYX_HOME,'credentials.json'));
  const status=await childProgram(entry,['status'],env,cwd);
  assert.match(status.stdout,/Ready/);
  assert.doesNotMatch(status.stdout,/Sign-in required|expired/);
  const after=await readFile(path.join(env.BUILDFYX_HOME,'credentials.json'));
  assert.deepEqual(after,before,'Credential bytes must be unchanged');
  const child=spawn(process.execPath,[entry,'--no-tui','--root',cwd,'--name','historical-test'],{
    env,cwd,stdio:['ignore','pipe','pipe'],windowsHide:true
  });
  let stderr='';
  child.stderr.on('data',buf=>{ stderr=(stderr+buf.toString()).slice(-3000); });
  const from=received.length;
  let ready;
  try {
    const timeout=Date.now()+15000;
    while(Date.now()<timeout) {
      ready=received.slice(from).find(x=>x.type==='device.ready');
      if(ready)break;
      if(child.exitCode!==null)throw new Error('Agent exited: '+stderr);
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    assert.ok(ready,'No authenticated device.ready frame ('+version+'): '+stderr);
    assert.equal(ready.protocolVersion,2);
    assert.equal(ready.deviceId,'test_device');
    assert.ok(typeof ready.instanceId==='string'&&ready.instanceId.length>0);
    assert.equal(ready.workspace?.name,'historical-test');
    const requestId='compat-'+version+'-'+Date.now();
    const client=connections.at(-1);
    assert.equal(client.readyState,1);
    client.send(JSON.stringify({type:'tool.call',requestId,instanceId:ready.instanceId,
      tool:'read_file',arguments:{path:'compat.txt'}}));
    let reply;
    const until=Date.now()+7000;
    while(Date.now()<until) {
      reply=received.slice(from).find(msg=>msg.requestId===requestId && ['tool.result','tool.error'].includes(msg.type));
      if(reply)break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.ok(reply,'Legacy read_file request timed out ('+version+'): '+stderr);
    assert.equal(reply.type,'tool.result',JSON.stringify(reply.error));
    assert.equal(reply.result.content,'Historical MCP tool contract passes');
    checks.push({version,kind:'Cloud mock handshake + real read_file MCP',passed:true,protocol:ready.protocolVersion});
  } finally {
    if(child.exitCode===null) {
      const exited=once(child,'exit');
      child.kill('SIGINT');
      await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Agent stop timeout')),5000))])
        .catch(()=>{child.kill('SIGKILL');});
    }
  }
  assert.deepEqual(await readFile(path.join(env.BUILDFYX_HOME,'credentials.json')),before);
}
try {
  for(const [directory,oldVersion] of [['agent032','0.3.2'],['agent033','0.3.3']]) {
    const home=path.join(temporary,directory,'home');
    const state=path.join(home,'.buildifyx');
    const cwd=path.join(temporary,directory,'workspace');
    await mkdir(state,{recursive:true});
    await mkdir(cwd,{recursive:true});
    await writeFile(path.join(cwd,'compat.txt'),'Historical MCP tool contract passes');
    const creds={cloudUrl:origin,deviceId:'test_device',deviceName:'historical-test',
      account:'demo@example.invalid',deviceToken:'test_device_secret',expiresAt:null,
      createdAt:'2026-01-01T00:00:00.000Z'};
    const initial=Buffer.from(JSON.stringify(creds,null,2)+'\n');
    await writeFile(path.join(state,'credentials.json'),initial,{mode:0o600});
    const env={...process.env,HOME:home,USERPROFILE:home,BUILDFYX_HOME:state,
      BUILDFYX_SKIP_UPDATE_CHECK:'1',CI:'1'};
    await runNpm(['install','--prefix',path.join(packagesRoot,directory),'--ignore-scripts','--no-audit','--no-fund',
      '@buildifyx/desktop-agent@'+oldVersion],{env:{...env,PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1'},timeout:60000});
    assert.equal(JSON.parse(await readFile(pkg(directory),'utf8')).version,oldVersion);
    await smoke(oldVersion,script(directory),env,cwd);
    // Real npm package replacement in the SAME prefix; no login/logout calls.
    await runNpm(['install','--prefix',path.join(packagesRoot,directory),'--ignore-scripts','--no-audit','--no-fund',tarball],{
      env:{...env,PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1'},timeout:60000
    });
    assert.equal(JSON.parse(await readFile(pkg(directory),'utf8')).version,'0.4.0');
    assert.deepEqual(await readFile(path.join(state,'credentials.json')),initial,'Upgrade must preserve credential bytes');
    await smoke('0.4.0',script(directory),env,cwd);
    checks.push({version:oldVersion+' -> 0.4.0',kind:'real npm prefix upgrade, stored login retained',passed:true});
  }
  console.log(JSON.stringify({pass:checks.length,checks},null,2));
}finally{
  for(const client of ws.clients)client.terminate();
  await new Promise(resolve=>ws.close(resolve));
  await new Promise(resolve=>server.close(resolve));
  await rm(temporary,{force:true,recursive:true});
}
