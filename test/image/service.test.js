import assert from 'node:assert/strict';
import { mkdtemp, mkdir, lstat, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createArtifactCache } from '../../src/cache/store.js';
import { createRuntime } from '../../src/core/runtime.js';
import { createImageServices, detectImageMime } from '../../src/image/service.js';
import { createPolicyManager } from '../../src/permissions/manager.js';
import { normalizePolicy } from '../../src/permissions/policy.js';
import { parseMcpToolInput } from '../../src/transport/mcp/tools/registry.js';

const sharp = createRequire(import.meta.url)('sharp');

async function fixture(t, overrides = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-image-')));
  const root = path.join(base, 'project');
  const other = path.join(base, 'other');
  const home = path.join(base, 'state');
  await mkdir(root); await mkdir(other);
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const cache = createArtifactCache({ workspaceRoot: root, homeDirectory: home, ...overrides });
  const policy = normalizePolicy({ categories: { imageRead: 'allow', imageSave: 'allow', cacheManage: 'allow', outsideRoot: 'deny' } });
  const runtime = createRuntime({ root, imageCache: cache, policy, interactive: false });
  t.after(() => { cache.close(); });
  return { base, root, other, home, cache, runtime };
}
const image = async (format = 'png', width = 32, height = 20) =>
  sharp({ create: { width, height, channels: 3, background: '#33aa99' } }).toFormat(format).toBuffer();

test('detect supported magic headers and reject mislabeled/non-image input', async () => {
  for (const format of ['png', 'jpeg', 'webp']) {
    const buffer = await image(format);
    assert.equal(detectImageMime(buffer), `image/${format === 'jpeg' ? 'jpeg' : format}`);
  }
  assert.throws(() => detectImageMime(Buffer.from('%PDF-not-an-image')), { code: 'IMAGE_FORMAT_UNSUPPORTED' });
});

test('read_image stores temporary image and metadata; no binary content claimed over MCP', async (t) => {
  const f = await fixture(t);
  const png = await image();
  await writeFile(path.join(f.root, 'input.png'), png);
  const result = await f.runtime.dispatch('read_image', { path: 'input.png' });
  assert.equal(result.format, 'png');
  assert.equal(result.width, 32);
  assert.equal(result.height, 20);
  assert.equal(result.imageBytesDelivered, false);
  assert.match(result.artifactId, /^art_/);
  assert.deepEqual((await f.cache.get(result.artifactId)).data, png);
  const info = await f.runtime.dispatch('get_image_info', { artifactId: result.artifactId });
  assert.equal(info.sha256, result.sha256);
  const listed = await f.runtime.dispatch('list_cached_assets', {});
  assert.deepEqual(listed.assets.map(asset => asset.id), [result.artifactId]);
  assert.equal((await f.runtime.dispatch('get_cached_image', { artifactId: result.artifactId })).imageBytesDelivered, false);
  await f.runtime.stop();
});

test('image info recognizes jpeg/webp and resizing bounds result without touching source', async (t) => {
  const f = await fixture(t);
  for (const format of ['jpeg', 'webp']) {
    await writeFile(path.join(f.root, `input.${format}`), await image(format, 60, 40));
    const info = await f.runtime.dispatch('get_image_info', { path: `input.${format}` });
    assert.equal(info.mimeType, `image/${format}`);
  }
  const before = await readFile(path.join(f.root, 'input.webp'));
  const resized = await f.runtime.dispatch('resize_image', {
    path: 'input.webp', width: 24, height: 24, format: 'png'
  });
  assert.equal(resized.mimeType, 'image/png');
  assert.equal(resized.width, 24);
  assert.equal(resized.height, 16);
  assert.deepEqual(await readFile(path.join(f.root, 'input.webp')), before);
  const resizeAgain = await f.runtime.dispatch('resize_image', { artifactId: resized.artifactId, width: 12 });
  assert.equal(resizeAgain.width, 12);
  assert.equal(resizeAgain.height, 8);
  assert.equal((await f.cache.get(resizeAgain.artifactId)).metadata.mimeType, 'image/png');
});

test('save_cached_image and save_image create only explicit new permanent files; cache clear never deletes them', async (t) => {
  const f = await fixture(t);
  const bytes = await image();
  await writeFile(path.join(f.root, 'src.png'), bytes);
  const { artifactId } = await f.runtime.dispatch('read_image', { path: 'src.png' });
  const saved = await f.runtime.dispatch('save_cached_image', { artifactId, destinationPath: 'permanent.png' });
  assert.equal(saved.saved, true);
  assert.deepEqual(await readFile(path.join(f.root, 'permanent.png')), bytes);
  const savedSecond = await f.runtime.dispatch('save_image', { path: 'src.png', destinationPath: 'copy.png' });
  assert.equal(savedSecond.saved, true);
  await assert.rejects(f.runtime.dispatch('save_cached_image', { artifactId, destinationPath: 'copy.png' }), { code: 'IMAGE_EXISTS' });
  await f.runtime.dispatch('clear_cache', {});
  assert.deepEqual(await readFile(path.join(f.root, 'permanent.png')), bytes);
  assert.deepEqual(await readFile(path.join(f.root, 'copy.png')), bytes);
  await assert.rejects(f.runtime.dispatch('get_cached_image', { artifactId }));
});

test('permissions default to ASK even when legacy read/write and fullAccess are allowed', async (t) => {
  const f = await fixture(t);
  const denied = createRuntime({ root: f.root, interactive: false, fullAccess: true });
  await writeFile(path.join(f.root, 'src.png'), await image());
  await assert.rejects(denied.dispatch('read_image', { path: 'src.png' }), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(denied.dispatch('clear_cache', {}), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(denied.dispatch('save_image', { path: 'src.png', destinationPath: 'output.png' }), { code: 'CONFIRMATION_REQUIRED' });
});

test('denies outside-root paths, traversal and symlink escape for reads and saves', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'src.png'), await image());
  await writeFile(path.join(f.other, 'outside.png'), await image());
  await assert.rejects(f.runtime.dispatch('read_image', { path: '../other/outside.png' }), { code: 'PERMISSION_DENIED' });
  await assert.rejects(f.runtime.dispatch('save_image', { path: 'src.png', destinationPath: '../other/new.png' }), { code: 'PERMISSION_DENIED' });
  await symlink(path.join(f.other, 'outside.png'), path.join(f.root, 'link.png'));
  await assert.rejects(f.runtime.dispatch('read_image', { path: 'link.png' }), { code: 'PERMISSION_DENIED' });
  const outsideSaved = path.join(f.other, 'new.png');
  await assert.rejects(readFile(outsideSaved), { code: 'ENOENT' });
});

test('permitted outside-root new destination requires independent root and imageSave authorization', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'src.png'), await image());
  const policy = normalizePolicy({ categories: { imageRead: 'allow', imageSave: 'allow', outsideRoot: 'allow' } });
  const allowed = createRuntime({ root: f.root, policy, interactive: false });
  const result = await allowed.dispatch('save_image', { path: 'src.png', destinationPath: path.join(f.other, 'new.png') });
  assert.equal(result.saved, true);
  assert.equal((await lstat(path.join(f.other, 'new.png'))).isFile(), true);
  const noSave = createRuntime({ root: f.root, policy: normalizePolicy({ categories: { imageSave: 'deny', outsideRoot: 'allow' } }), interactive: false });
  await assert.rejects(noSave.dispatch('save_image', { path: 'src.png', destinationPath: path.join(f.other, 'blocked.png') }), { code: 'PERMISSION_DENIED' });
});

test('reject spoofed formats, corrupted bytes, oversized image and unsafe source files', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'fake.jpg'), Buffer.from('a'.repeat(128)));
  await assert.rejects(f.runtime.dispatch('read_image', { path: 'fake.jpg' }), { code: 'IMAGE_FORMAT_UNSUPPORTED' });
  await writeFile(path.join(f.root, 'truncated.png'), (await image()).subarray(0, 32));
  await assert.rejects(f.runtime.dispatch('read_image', { path: 'truncated.png' }), { code: 'IMAGE_INVALID' });
  await writeFile(path.join(f.root, 'huge.png'), Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(f.runtime.dispatch('get_image_info', { path: 'huge.png' }), { code: 'IMAGE_TOO_LARGE' });
  await assert.rejects(f.runtime.dispatch('resize_image', { path: 'fake.jpg', width: 8193 }), { code: 'IMAGE_INVALID' });
});

test('cache owner is fenced to its original workspace and namespace', async (t) => {
  const f = await fixture(t);
  const other = createArtifactCache({ workspaceRoot: f.other, homeDirectory: f.home });
  t.after(() => other.close());
  const png = await image();
  await writeFile(path.join(f.root, 'sample.png'), png);
  const { artifactId } = await f.runtime.dispatch('read_image', { path: 'sample.png' });
  const otherService = createImageServices({ root: f.other, cache: other });
  await assert.rejects(otherService.get_cached_image({ artifactId }), { code: 'CACHE_NOT_FOUND' });
  await assert.rejects(otherService.save_cached_image({ artifactId, destinationPath: 'stolen.png' }), { code: 'CACHE_NOT_FOUND' });
});

test('tool schemas reject multiple image selectors, missing dimensions and malformed IDs', () => {
  assert.throws(() => parseMcpToolInput('get_image_info', { path: 'a.png', artifactId: 'x' }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseMcpToolInput('read_image', { path: '' }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseMcpToolInput('resize_image', { path: 'a.png', width: 0 }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseMcpToolInput('save_cached_image', { artifactId: '../../file', destinationPath: 'x' }), { code: 'INVALID_INPUT' });
});

test('transfer staging files are not accessible or permanently savable as cached images', async (t) => {
  const f = await fixture(t);
  const payload = await image();
  const transfer = await f.cache.put({ data: payload, kind: 'transfer', mimeType: 'image/png' });
  await assert.rejects(f.runtime.dispatch('get_cached_image', { artifactId: transfer.id }), { code: 'IMAGE_INVALID' });
  await assert.rejects(f.runtime.dispatch('save_cached_image', { artifactId: transfer.id, destinationPath: 'no.png' }), { code: 'IMAGE_INVALID' });
  await assert.rejects(readFile(path.join(f.root, 'no.png')), { code: 'ENOENT' });
});

test('outside-root approval and permanent-save approval are separate gates', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'source.png'), await image());
  const policy = normalizePolicy({ categories: { imageRead: 'allow', imageSave: 'ask', outsideRoot: 'ask' } });
  const runtime = createRuntime({ root: f.root, policy, interactive: true });
  const pending = runtime.dispatch('save_image', { path: 'source.png', destinationPath: path.join(f.other, 'approved.png') });
  async function resolveApproval(category) {
    let request;
    for (let i = 0; i < 120; i++) {
      request = runtime.approvalQueue.getPending().find((entry) => entry.category === category);
      if (request) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(request?.category, category);
    assert.equal(runtime.approvalQueue.resolve(request.id, { action: 'allow', remember: null }), true);
  }
  await resolveApproval('outsideRoot');
  await resolveApproval('imageSave');
  assert.equal((await pending).saved, true);
  assert.equal((await readFile(path.join(f.other, 'approved.png'))).length > 0, true);
  await runtime.stop();
});
