import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
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
