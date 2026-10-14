import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createArtifactCache } from '../../src/cache/store.js';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'bdxa-cache-'));
  const homeDirectory = path.join(base, 'buildifyx-home');
  const workspaceA = path.join(base, 'workspace-a');
  const workspaceB = path.join(base, 'workspace-b');
  await mkdir(workspaceA);
  await mkdir(workspaceB);
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const cache = (workspaceRoot = workspaceA, options = {}) => {
    const created = createArtifactCache({ homeDirectory, workspaceRoot, ...options });
    t.after(() => created.close());
    return created;
  };
  return { base, homeDirectory, workspaceA, workspaceB, cache };
}
const bytes = (value) => Buffer.from(value, 'utf8');

test('persistent installation identity and canonical workspace identity survive recreation; namespaces remain isolated', async (t) => {
  const f = await fixture(t);
  const a = f.cache();
  const same = f.cache(path.join(f.workspaceA, '..', 'workspace-a'));
  const other = f.cache(f.workspaceB);
  const local = f.cache(f.workspaceA, { namespace: 'local' });
  const [identityA, identitySame, identityOther, identityLocal] = await Promise.all([
    a.identity(), same.identity(), other.identity(), local.identity()
  ]);
  assert.equal(identityA.deviceInstallId, identitySame.deviceInstallId);
  assert.equal(identityA.deviceInstallId, identityOther.deviceInstallId);
  assert.equal(identityA.ownerKey, identitySame.ownerKey);
  assert.notEqual(identityA.ownerKey, identityOther.ownerKey);
  assert.notEqual(identityA.ownerKey, identityLocal.ownerKey);
  const asset = await a.put({ data: bytes('hello') });
  assert.deepEqual((await same.get(asset.id)).data, bytes('hello'));
  await assert.rejects(other.get(asset.id), { code: 'CACHE_NOT_FOUND' });
  await assert.rejects(local.get(asset.id), { code: 'CACHE_NOT_FOUND' });
});

test('cache writes private data and metadata with integrity and only opaque filenames', async (t) => {
  const f = await fixture(t);
  const c = f.cache();
  const record = await c.put({ data: bytes('picture-payload'), mimeType: 'image/png', kind: 'image', origin: 'generated' });
  assert.match(record.id, /^art_[a-f0-9-]+$/);
  assert.equal(record.size, 15);
  assert.equal((await c.get(record.id)).data.toString(), 'picture-payload');
  assert.deepEqual((await c.list()).map((entry) => entry.id), [record.id]);
  assert.equal(Object.hasOwn(record, 'ownerKey'), false);
  const identity = await c.identity();
  const ownerDir = path.join(f.homeDirectory, 'cache', 'v1', 'owners', identity.ownerKey);
  const info = await stat(path.join(ownerDir, 'data', `${record.id}.bin`));
  assert.equal(info.size, record.size);
  if (process.platform !== 'win32') {
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal((await stat(ownerDir)).mode & 0o777, 0o700);
  }
  const persisted = JSON.parse(await readFile(path.join(ownerDir, 'meta', `${record.id}.json`), 'utf8'));
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.ownerKey, identity.ownerKey);
  assert.equal(persisted.sha256.length, 64);
});

test('invalid ids, empty/oversized writes, untrusted metadata and bad config fail closed', async (t) => {
  const f = await fixture(t);
  const c = f.cache(undefined, { quotaBytes: 32, maxArtifactBytes: 16 });
  await assert.rejects(c.get('../../victim'), { code: 'CACHE_INVALID_ID' });
  await assert.rejects(c.put({ data: bytes('') }), { code: 'CACHE_INVALID_DATA' });
  await assert.rejects(c.put({ data: Buffer.alloc(17) }), { code: 'CACHE_INVALID_DATA' });
  await assert.rejects(c.put({ data: bytes('x'), origin: '../outside' }), TypeError);
  await assert.rejects(c.put({ data: bytes('x'), mimeType: 'image/../secret' }), TypeError);
  assert.throws(() => f.cache(undefined, { ttlMs: 0 }), TypeError);
});

test('expired artifacts are removed on restart, periodic initialization is stoppable and saved workspace files are untouched', async (t) => {
  const f = await fixture(t);
  let clock = 1_000_000;
  const c = f.cache(undefined, { ttlMs: 100, now: () => clock, cleanupIntervalMs: 20 });
  const saved = path.join(f.workspaceA, 'user-saved.png');
  await writeFile(saved, bytes('SAVED FOREVER'));
  const asset = await c.put({ data: bytes('TEMP') });
  clock += 101;
  const afterRestart = f.cache(undefined, { ttlMs: 100, now: () => clock });
  const report = await afterRestart.initialize({ periodic: true });
  assert.equal(report.usageBytes, 0);
  assert.deepEqual(await afterRestart.list(), []);
  await assert.rejects(c.get(asset.id), { code: 'CACHE_NOT_FOUND' });
  assert.equal((await readFile(saved)).toString(), 'SAVED FOREVER');
  afterRestart.close();
});

test('quota evicts oldest unpinned artifact, pinning blocks quota eviction without making anything permanent', async (t) => {
  const f = await fixture(t);
  let clock = 1000;
  const c = f.cache(undefined, { quotaBytes: 12, maxArtifactBytes: 10, now: () => clock });
  const old = await c.put({ data: bytes('aaaaaaaa') });
  clock++;
  const next = await c.put({ data: bytes('bbbbbbbb') });
  await assert.rejects(c.get(old.id), { code: 'CACHE_NOT_FOUND' });
  assert.equal((await c.get(next.id)).data.length, 8);
  await c.setPinned(next.id, true);
  assert.equal((await c.list())[0].pinned, true);
  await assert.rejects(c.put({ data: bytes('cccccccc') }), { code: 'CACHE_QUOTA_EXCEEDED' });
  await c.setPinned(next.id, false);
  await c.put({ data: bytes('dddddddd') });
  await assert.rejects(c.get(next.id), { code: 'CACHE_NOT_FOUND' });
});

test('lease prevents concurrent deletion and quota eviction; checksum mismatch is rejected', async (t) => {
  const f = await fixture(t);
  const c1 = f.cache(undefined, { quotaBytes: 12, maxArtifactBytes: 10 });
  const c2 = f.cache(undefined, { quotaBytes: 12, maxArtifactBytes: 10 });
  const asset = await c1.put({ data: bytes('abcdefgh') });
  await c1.withLease(asset.id, async ({ read, metadata }) => {
    assert.equal(metadata.id, asset.id);
    assert.equal((await read()).toString(), 'abcdefgh');
    await assert.rejects(c2.remove(asset.id), { code: 'CACHE_IN_USE' });
    await assert.rejects(c2.put({ data: bytes('12345678') }), { code: 'CACHE_QUOTA_EXCEEDED' });
  });
  assert.equal(await c2.remove(asset.id), true);
  const check = await c1.put({ data: bytes('abcdefgh') });
  const owner = await c1.identity();
  const dataPath = path.join(f.homeDirectory, 'cache', 'v1', 'owners', owner.ownerKey, 'data', `${check.id}.bin`);
  await writeFile(dataPath, bytes('12345678'));
  await assert.rejects(c1.get(check.id), { code: 'CACHE_CORRUPT' });
});

test('clear removes only the owning workspace temporary artifacts and preserves files outside cache', async (t) => {
  const f = await fixture(t);
  const c1 = f.cache();
  const c2 = f.cache(f.workspaceB);
  const a = await c1.put({ data: bytes('A') });
  const b = await c2.put({ data: bytes('B') });
  const permanent = path.join(f.workspaceA, 'image.png');
  await writeFile(permanent, bytes('USER DATA'));
  assert.deepEqual(await c1.clear(), { removed: 1 });
  await assert.rejects(c1.get(a.id), { code: 'CACHE_NOT_FOUND' });
  assert.equal((await c2.get(b.id)).data.toString(), 'B');
  assert.equal((await readFile(permanent)).toString(), 'USER DATA');
  assert.deepEqual(await c1.clear(), { removed: 0 });
});

test('startup cleanup safely recovers orphan files and unfinished temporary files', async (t) => {
  const f = await fixture(t);
  const c = f.cache();
  const owner = await c.identity();
  const root = path.join(f.homeDirectory, 'cache', 'v1', 'owners', owner.ownerKey);
  const orphan = path.join(root, 'data', `art_${randomUUID()}.bin`);
  const partial = path.join(root, 'tmp', '.tmp-interrupted');
  await writeFile(orphan, 'orphan');
  await writeFile(partial, 'partial');
  await c.initialize();
  await assert.rejects(stat(orphan), { code: 'ENOENT' });
  await assert.rejects(stat(partial), { code: 'ENOENT' });
});

test('symlinked cache bytes or redirected directories cannot read or delete external files', async (t) => {
  const f = await fixture(t);
  const c = f.cache();
  const a = await c.put({ data: bytes('internal') });
  const outside = path.join(f.workspaceA, 'important.txt');
  await writeFile(outside, bytes('do not touch'));
  const owner = await c.identity();
  const dataPath = path.join(f.homeDirectory, 'cache', 'v1', 'owners', owner.ownerKey, 'data', `${a.id}.bin`);
  await unlink(dataPath);
  await symlink(outside, dataPath);
  await assert.rejects(c.get(a.id), { code: 'CACHE_UNSAFE_PATH' });
  await assert.rejects(c.prune(), { code: 'CACHE_UNSAFE_PATH' });
  assert.equal((await readFile(outside)).toString(), 'do not touch');
});

test('concurrent cache instances serialize writes and quota across workspaces', async (t) => {
  const f = await fixture(t);
  const a = f.cache(undefined, { quotaBytes: 64, maxArtifactBytes: 8 });
  const b = f.cache(f.workspaceB, { quotaBytes: 64, maxArtifactBytes: 8 });
  await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).put({ data: Buffer.alloc(8, i) })));
  const all = [...await a.list(), ...await b.list()];
  assert.equal(all.length, 8);
  assert.equal(all.reduce((total, entry) => total + entry.size, 0), 64);
  const extra = await b.put({ data: Buffer.alloc(8) });
  assert.equal([...await a.list(), ...await b.list()].length, 8);
  assert.equal((await b.get(extra.id)).data.length, 8);
});

test('audit deletion events contain identifiers and reason but never artifact bytes or workspace path', async (t) => {
  const f = await fixture(t);
  const events = [];
  const c = f.cache(undefined, { audit: (record) => events.push(record) });
  const asset = await c.put({ data: bytes('super-secret-image'), origin: 'import' });
  await c.remove(asset.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'explicit');
  assert.equal(events[0].id, asset.id);
  assert.doesNotMatch(JSON.stringify(events), /super-secret-image|workspace-a|deviceInstallId/);
});

test('pinned temporary artifacts still expire; corrupted metadata is removed without touching saved files', async (t) => {
  const f = await fixture(t);
  let clock = 1_000;
  const c = f.cache(undefined, { ttlMs: 30, now: () => clock });
  const a = await c.put({ data: bytes('temporary'), pinned: true });
  const key = (await c.identity()).ownerKey;
  const dir = path.join(f.homeDirectory, 'cache', 'v1', 'owners', key);
  clock += 31;
  await c.prune();
  await assert.rejects(c.get(a.id), { code: 'CACHE_NOT_FOUND' });
  const b = await c.put({ data: bytes('tamper') });
  await writeFile(path.join(dir, 'meta', `${b.id}.json`), '{bad-json');
  await c.prune();
  assert.deepEqual(await c.list(), []);
  await assert.rejects(stat(path.join(dir, 'data', `${b.id}.bin`)), { code: 'ENOENT' });
});

test('stale crash leases and stale lock directories are recovered without recursive deletion', async (t) => {
  const f = await fixture(t);
  const c = f.cache();
  const asset = await c.put({ data: bytes('payload') });
  const owner = await c.identity();
  const version = path.join(f.homeDirectory, 'cache', 'v1');
  const leaseFile = path.join(version, 'owners', owner.ownerKey, 'leases', `${asset.id}.${randomUUID()}.lease`);
  await writeFile(leaseFile, '');
  const old = new Date(Date.now() - 180_000);
  const { utimes } = await import('node:fs/promises');
  await utimes(leaseFile, old, old);
  const lockPath = path.join(version, '.cache.lock');
  await mkdir(lockPath);
  await utimes(lockPath, old, old);
  await c.prune();
  await assert.rejects(stat(leaseFile), { code: 'ENOENT' });
  assert.equal(await c.remove(asset.id), true);
});

test('reject symlinked cache directory without following its external target', async (t) => {
  const f = await fixture(t);
  const c = f.cache();
  const owner = await c.identity();
  const asset = await c.put({ data: bytes('internal') });
  const dir = path.join(f.homeDirectory, 'cache', 'v1', 'owners', owner.ownerKey);
  const target = path.join(f.workspaceA, 'saved');
  await mkdir(target);
  await writeFile(path.join(target, 'keep.txt'), 'important');
  await rm(path.join(dir, 'data'), { recursive: true });
  await symlink(target, path.join(dir, 'data'));
  await assert.rejects(c.get(asset.id), /Unsafe cache directory/);
  await assert.rejects(c.list(), /Unsafe cache directory/);
  await assert.rejects(c.prune(), /Unsafe cache directory/);
  assert.equal((await readFile(path.join(target, 'keep.txt'))).toString(), 'important');
});

test('explicit deletion does not complete when another process holds a lease', async (t) => {
  const f = await fixture(t);
  const c1 = f.cache();
  const c2 = f.cache();
  const a = await c1.put({ data: bytes('keep') });
  const readAfterClose = await c1.withLease(a.id, async (lease) => {
    assert.equal((await c2.clear()).removed, 0);
    assert.equal((await lease.read()).toString(), 'keep');
    return lease.read;
  });
  await assert.rejects(readAfterClose(), { code: 'CACHE_LEASE_CLOSED' });
  assert.deepEqual(await c2.clear(), { removed: 1 });
});

test('invalid installation identity symlink is rejected without reading external content', async (t) => {
  const f = await fixture(t);
  const c = f.cache();
  await c.identity();
  const outside = path.join(f.workspaceA, 'important.txt');
  await writeFile(outside, 'private');
  const installPath = path.join(f.homeDirectory, 'cache', 'device-install.json');
  await unlink(installPath);
  await symlink(outside, installPath);
  const fresh = f.cache(f.workspaceB);
  await assert.rejects(fresh.identity(), /Unsafe cache device identity/);
  assert.equal((await readFile(outside)).toString(), 'private');
});