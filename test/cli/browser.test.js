import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { browserInstallationStatus, installBrowser, runBrowser } from '../../src/cli/commands/browser.js';
import { getPackageMetadata } from '../../src/version.js';
import { printHelp } from '../../src/cli/help.js';
import { parseInvocation } from '../../src/cli/options.js';

test('v0.4.0 package and lockfile share declared dependencies, entrypoints and browser workflow',async()=>{
  const packageInfo=JSON.parse(await readFile('package.json','utf8'));
  const lock=JSON.parse(await readFile('package-lock.json','utf8'));
  assert.equal((await getPackageMetadata()).version,'0.4.0');
  assert.equal(packageInfo.version,'0.4.0');
  assert.equal(lock.version,'0.4.0');
  assert.equal(lock.packages[''].version,'0.4.0');
  assert.deepEqual(lock.packages[''].dependencies,packageInfo.dependencies);
  assert.equal(packageInfo.dependencies.playwright!==undefined,true);
  assert.equal(packageInfo.dependencies.sharp!==undefined,true);
  assert.ok(packageInfo.files.includes('docs'));
  assert.ok(packageInfo.files.includes('src'));
  assert.match(packageInfo.scripts['browser:install'],/browser install/);
  assert.match(packageInfo.scripts['browser:check'],/browser check/);
  assert.match(packageInfo.scripts.prepublishOnly,/pack:check/);
  assert.deepEqual(parseInvocation(['browser','check']),{command:'browser',args:['check']});
});

test('browser check remains offline and reports missing binary without installing it',async()=>{
  const lines=[];
  let installed=0;
  const info=await runBrowser(['check'],{
    status:()=>({installed:false,platform:'linux',architecture:'x64'}),
    install:async()=>{installed++;},
    print:x=>lines.push(x)
  });
  assert.equal(info.installed,false);
  assert.equal(installed,0);
  assert.match(lines.join('\n'),/not installed/);
  assert.match(lines.join('\n'),/bdxa browser install/);
  assert.equal(browserInstallationStatus({adapter:{executablePath:()=>'/missing/chromium'},fileExists:()=>false}).installed,false);
});

test('installer explicitly executes the pinned Playwright package CLI without shell or default downloads',async()=>{
  let invocation;
  await installBrowser({runInstaller:async(command,args)=>{invocation={command,args};}});
  assert.equal(invocation.command,process.execPath);
  assert.equal(path.basename(invocation.args[0]),'cli.js');
  assert.deepEqual(invocation.args.slice(1),['install','chromium']);
  assert.match(invocation.args[0],/playwright/);
  let runs=0;
  const printed=[];
  const installed=await runBrowser(['install'],{
    status:()=>({installed:true,platform:'darwin',architecture:'arm64'}),
    install:async()=>{runs++;},
    print:x=>printed.push(x)
  });
  assert.equal(runs,1);
  assert.equal(installed.installed,true);
  assert.match(printed.join('\n'),/explicitly/);
});

test('installer reports invalid commands and a missing post-install browser rather than claiming success',async()=>{
  await assert.rejects(runBrowser(['install','--with-deps']),/bdxa browser check/);
  await assert.rejects(runBrowser(['remove']),/bdxa browser check/);
  await assert.rejects(runBrowser(['install'],{
    install:async()=>{},
    status:()=>({installed:false,platform:'linux',architecture:'x64'}),
    print:()=>{}
  }),/without the expected browser executable/);
});

test('CLI help advertises explicit optional browser installation',()=>{
  const lines=[];
  const log=console.log;
  console.log=(...args)=>lines.push(args.join(' '));
  try{printHelp();}
  finally{console.log=log;}
  const help=lines.join('\n');
  assert.match(help,/bdxa browser check/);
  assert.match(help,/bdxa browser install/);
});

test('real CLI browser check executes exactly once and never falls through to doctor',()=>{
  const result=spawnSync(process.execPath,['./src/cli.js','browser','check'],{
    encoding:'utf8',timeout:15000,env:{...process.env,BUILDIFYX_SKIP_UPDATE_CHECK:'1'}
  });
  assert.equal(result.error,undefined);
  assert.match(result.stdout,/Playwright Chromium: (installed|not installed)/);
  assert.equal((result.stdout.match(/Playwright Chromium:/g)??[]).length,1);
  assert.doesNotMatch(result.stdout,/Buildifyx Desktop Agent doctor/);
  assert.deepEqual(result.status,result.stdout.includes('not installed')?1:0);
  const version=spawnSync(process.execPath,['./src/cli.js','--version'],{
    encoding:'utf8',timeout:15000,env:{...process.env,BUILDIFYX_SKIP_UPDATE_CHECK:'1'}
  });
  assert.equal(version.status,0);
  assert.equal(version.stdout.trim(),'0.4.0');
});

test('Linux browser check distinguishes executable presence from missing native runtime libraries',async()=>{
  const lines=[];
  const info=await runBrowser(['check'],{
    status:()=>({installed:true,platform:'linux',architecture:'arm64'}),
    print:value=>lines.push(value)
  });
  assert.equal(info.installed,true);
  assert.match(lines.join('\\n'),/Executable check only/);
  assert.match(lines.join('\\n'),/system libraries/);
  assert.doesNotMatch(lines.join('\\n'),/Run `bdxa browser install`/);
});
