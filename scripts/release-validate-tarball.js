import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { requireIsolatedReleasePrefix } from './release-temp-prefix.js';

const prefix = requireIsolatedReleasePrefix(process.argv[2]);
const installed = path.join(prefix,'node_modules','@buildifyx','desktop-agent');
const load = async relative => import(pathToFileURL(path.join(installed,relative)).href);
const require = createRequire(path.join(installed,'package.json'));
const sharp=require('sharp');
const { createRuntime } = await load('src/core/runtime.js');
const { createArtifactCache } = await load('src/cache/store.js');
const { normalizePolicy } = await load('src/permissions/policy.js');
const { getPackageMetadata } = await load('src/version.js');
const { createToolManifest } = await load('src/transport/mcp/tools/registry.js');
const { browserInstallationStatus } = await load('src/cli/commands/browser.js');
const expected=(await getPackageMetadata()).version;
assert.equal(expected,'0.4.0');
const manifest=createToolManifest();
assert.equal(manifest.count,29);
for(const tool of ['read_image','resize_image','save_cached_image','browser_screenshot','browser_diagnostics'])
  assert.ok(manifest.tools.some(entry=>entry.name===tool),tool);
const defaults=normalizePolicy().categories;
for(const name of ['imageRead','imageSave','cacheManage','browserRead','browserNavigate',
  'browserInteract','browserCapture','browserDiagnostics','browserSensitive','browserExternal','persistentProfile']) {
  assert.equal(defaults[name],'ask',name);
}
const root=await mkdtemp(path.join(os.tmpdir(), 'bdx-pkg11-'));
const work=path.join(root,'workspace');
await mkdir(work);
const cache=createArtifactCache({workspaceRoot:work,namespace:'local',homeDirectory:path.join(root,'private')});
const policy=normalizePolicy({categories:{imageRead:'allow',imageSave:'allow',cacheManage:'allow'}});
const runtime=createRuntime({root:work,namespace:'local',instanceId:'inst_package11',
  principalId:'principal_package11',imageCache:cache,policy,interactive:false});
try {
  const source='test-image.png';
  await sharp({create:{width:64,height:48,channels:3,background:'#335577'}}).png().toFile(path.join(work,source));
  const imported=await runtime.dispatch('read_image',{path:source});
  assert.equal(imported.mimeType,'image/png');
  assert.equal(imported.width,64);
  assert.equal(imported.height,48);
  const resized=await runtime.dispatch('resize_image',{artifactId:imported.artifactId,width:32,height:24});
  assert.equal(resized.width,32);
  assert.equal(resized.height,24);
  const copied=await runtime.dispatch('save_cached_image',{artifactId:resized.artifactId,destinationPath:'saved.png'});
  assert.equal(copied.saved,true);
  assert.equal((await sharp(await readFile(path.join(work,'saved.png'))).metadata()).width,32);
  await assert.rejects(runtime.dispatch('save_cached_image',{artifactId:resized.artifactId,destinationPath:'saved.png'}));
  await runtime.dispatch('clear_cache',{});
  assert.equal((await sharp(await readFile(path.join(work,'saved.png'))).metadata()).height,24);
  const browser=browserInstallationStatus();
  console.log(JSON.stringify({passed:true,packageVersion:expected,toolCount:manifest.count,
    imageFlow:'read_image -> resize_image -> save_cached_image -> clear_cache (saved file retained)',
    freshPlaywright:JSON.parse(await readFile(path.join(prefix,'node_modules','playwright','package.json'),'utf8')).version,
    sharpVersion:JSON.parse(await readFile(path.join(prefix,'node_modules','sharp','package.json'),'utf8')).version,
    browserAvailable:browser.installed,
    platform:browser.platform+' '+browser.architecture},null,2));
} finally {
  await runtime.stop();
  cache.close();
  await rm(root,{recursive:true,force:true});
}
