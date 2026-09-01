import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../../src/core/runtime.js';
import { normalizePolicy } from '../../src/permissions/policy.js';

test('cloud request ids are reused for approvals and cancellation prevents late execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-cancel-'));
  try {
    await writeFile(path.join(root, 'example.txt'), 'hello');
    const runtime = createRuntime({
      root,
      policy: normalizePolicy({ categories: { read: 'ask' } }),
      interactive: true
    });

    const execution = runtime.dispatch('read_file', { path: 'example.txt' }, { requestId: 'req_cloud_123' });
    for (let index = 0; index < 50 && runtime.approvalQueue.getPending().length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const [approval] = runtime.approvalQueue.getPending();
    assert.equal(approval.id, 'req_cloud_123');
    assert.equal(runtime.cancel('req_cloud_123', 'Cloud request timed out'), true);
    await assert.rejects(execution, (error) => error?.code === 'REQUEST_CANCELLED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
