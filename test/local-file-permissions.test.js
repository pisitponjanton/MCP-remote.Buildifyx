import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAuditLogger } from '../src/audit/logger.js';
import { createEventBus } from '../src/events/bus.js';
import { openInstanceLog } from '../src/utils/instances.js';

async function waitForFile(filePath) {
  for (let index = 0; index < 100; index += 1) {
    try { return await stat(filePath); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

test('audit and instance logs are private to the local user', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-private-'));
  try {
    const eventBus = createEventBus();
    const auditPath = path.join(root, 'audit.log');
    const audit = createAuditLogger({ eventBus, filePath: auditPath });
    audit.start();
    eventBus.emit('test.event', { value: true });
    const auditStat = await waitForFile(auditPath);
    audit.stop();
    await audit.flush();
    assert.equal(auditStat.mode & 0o777, 0o600);

    const instancesDir = path.join(root, 'instances');
    const { filePath, handle } = await openInstanceLog('inst_permissions_test', instancesDir);
    await handle.close();
    const logStat = await stat(filePath);
    assert.equal(logStat.mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('audit flush waits for queued events before shutdown completes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-audit-flush-'));
  try {
    const eventBus = createEventBus();
    const auditPath = path.join(root, 'audit.log');
    const audit = createAuditLogger({ eventBus, filePath: auditPath });
    audit.start();
    for (let index = 0; index < 25; index += 1) eventBus.emit('flush.event', { index });
    audit.stop();
    await audit.flush();

    const records = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.length, 25);
    assert.equal(records.at(-1).index, 24);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
