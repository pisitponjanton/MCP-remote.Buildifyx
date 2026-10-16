import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createRuntime } from '../../src/core/runtime.js';
import { AgentError, publicToolError } from '../../src/core/errors.js';
import { normalizePolicy } from '../../src/permissions/policy.js';

const sharp = createRequire(import.meta.url)('sharp');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function setup(t, changes = {}, interactive = false) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-phase3-save-')));
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  const policy = normalizePolicy({ categories: {
    imageRead: 'allow', cacheManage: 'allow', imageSave: 'allow',
    outsideRoot: 'deny', ...changes
  } });
  const runtime = createRuntime({ root, policy, interactive, namespace: 'local',
    imageCache: {
      initialize: async () => {},
      close() {},
      list: async () => [],
      get: async () => { throw new Error('Unexpected persistent cache read'); }
    } });
  t.after(async () => {
    await runtime.stop().catch(() => {});
    await rm(base, { recursive: true, force: true });
  });
  return { base, root, outside, runtime };
}
const payload = format => sharp({
  create: { width: 8, height: 6, channels: 3, background: '#6677aa' }
}).toFormat(format).toBuffer();

async function approval(runtime, category) {
  for (let i = 0; i < 150; i++) {
    const result = runtime.approvalQueue.getPending().find(item => item.category === category);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for approval ' + category);
}
function decide(runtime, item, action = 'allow') {
  assert.equal(runtime.approvalQueue.resolve(item.id, { action, remember: null }), true);
}

test('Phase 3: imported PNG/JPEG/WebP stay RAM-only until explicit authorized Runtime save', async t => {
  for (const format of ['png', 'jpeg', 'webp']) {
    await t.test(format, async inner => {
      const f = await setup(inner);
      const bytes = await payload(format);
      const metadata = await f.runtime.services.__importCloudImage(bytes);
      assert.match(metadata.artifactId, /^art_[0-9a-f-]{36}$/);
      assert.equal(metadata.sha256, digest(bytes));
      const cached = await f.runtime.dispatch('get_cached_image', { artifactId: metadata.artifactId });
      assert.equal(cached.sha256, digest(bytes));
      assert.equal(cached.imageBytesDelivered, false);
      assert.deepEqual(await readdir(f.root), [], 'Reading a RAM artifact never writes a file');
      const output = 'explicit.' + format;
      const saved = await f.runtime.dispatch('save_cached_image', {
        artifactId: metadata.artifactId, destinationPath: output
      });
      assert.equal(saved.saved, true);
      assert.equal(saved.sha256, metadata.sha256);
      assert.equal(saved.mimeType, metadata.mimeType);
      assert.deepEqual(await readFile(path.join(f.root, output)), bytes);
    });
  }
});

test('Phase 3: imageSave deny blocks a RAM artifact even with imageRead/cacheManage allow', async t => {
  const f = await setup(t, { imageSave: 'deny' });
  const meta = await f.runtime.services.__importCloudImage(await payload('png'));
  await assert.rejects(f.runtime.dispatch('save_cached_image', {
    artifactId: meta.artifactId, destinationPath: 'not-saved.png'
  }), e => e.code === 'PERMISSION_DENIED' && e.details?.category === 'imageSave');
  assert.deepEqual(await readdir(f.root), []);
});

test('Phase 3: imageSave Ask names the destination in the approval and needs explicit consent', async t => {
  const f = await setup(t, { imageSave: 'ask' }, true);
  const bytes = await payload('png');
  const meta = await f.runtime.services.__importCloudImage(bytes);
  const saving = f.runtime.dispatch('save_cached_image', {
    artifactId: meta.artifactId, destinationPath: 'user-approved.png'
  });
  const pending = await approval(f.runtime, 'imageSave');
  assert.equal(pending.toolName, 'save_cached_image');
  assert.match(pending.description, /user-approved\.png/, 'Approval must show the actual destination filename');
  assert.equal(existsSync(path.join(f.root, 'user-approved.png')), false);
  decide(f.runtime, pending);
  assert.equal((await saving).saved, true);
  assert.deepEqual(await readFile(path.join(f.root, 'user-approved.png')), bytes);
});

test('Phase 3: explicit save cannot overwrite and cannot escape via path traversal or symlink', async t => {
  const f = await setup(t);
  const bytes = await payload('png');
  const meta = await f.runtime.services.__importCloudImage(bytes);
  const existing = Buffer.from('preserve original file');
  await writeFile(path.join(f.root, 'existing.png'), existing);
  await assert.rejects(f.runtime.dispatch('save_cached_image', {
    artifactId: meta.artifactId, destinationPath: 'existing.png'
  }), { code: 'IMAGE_EXISTS' });
  assert.deepEqual(await readFile(path.join(f.root, 'existing.png')), existing);
  await assert.rejects(f.runtime.dispatch('save_cached_image', {
    artifactId: meta.artifactId, destinationPath: '../outside/escape.png'
  }), { code: 'PERMISSION_DENIED' });
  const redirect = path.join(f.root, 'redirect');
  await symlink(f.outside, redirect, 'dir');
  await assert.rejects(f.runtime.dispatch('save_cached_image', {
    artifactId: meta.artifactId, destinationPath: 'redirect/escape.png'
  }), { code: 'PERMISSION_DENIED' });
  assert.deepEqual(await readdir(f.outside), []);
});

test('Phase 3: outside-root approval does not override revoked imageSave permission', async t => {
  const f = await setup(t, { outsideRoot: 'ask' }, true);
  const meta = await f.runtime.services.__importCloudImage(await payload('png'));
  const dest = path.join(f.outside, 'should-not-exist.png');
  const saving = f.runtime.dispatch('save_cached_image', {
    artifactId: meta.artifactId, destinationPath: dest
  });
  const pending = await approval(f.runtime, 'outsideRoot');
  await f.runtime.policyManager.setCategory('imageSave', 'deny');
  decide(f.runtime, pending);
  await assert.rejects(saving, e =>
    e.code === 'PERMISSION_DENIED' && e.details?.category === 'imageSave');
  assert.equal(existsSync(dest), false);
});

test('Phase 3: reject invalid artifact IDs before permanent save via validated MCP input', async t => {
  const f = await setup(t);
  const { parseMcpToolInput } = await import('../../src/transport/mcp/tools/registry.js');
  assert.throws(() => parseMcpToolInput('save_cached_image', {
    artifactId: '../outside.png', destinationPath: 'x.png'
  }), { code: 'INVALID_INPUT' });
  assert.deepEqual(await readdir(f.root), []);
});

test('Phase 3: image save failures provide actionable safe client errors without disclosing internal paths', () => {
  const checks = [
    ['IMAGE_EXISTS', /Choose a new filename/],
    ['IMAGE_PATH_DENIED', /approved workspace root/],
    ['IMAGE_PATH_CHANGED', /try again/],
    ['MEDIA_IMPORT_PERMISSION_REQUIRED', /imageRead and cacheManage/],
    ['CACHE_NOT_FOUND', /Import the image again/]
  ];
  for (const [code, expected] of checks) {
    const result = publicToolError(new AgentError(code, 'SECRET_USER_PATH_OR_TOKEN'));
    assert.equal(result.code, code);
    assert.match(result.message, expected);
    assert.equal(JSON.stringify(result).includes('SECRET_USER_PATH_OR_TOKEN'), false);
  }
});
