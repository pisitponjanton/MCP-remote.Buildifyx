import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('cancellation between sequential permission gates prevents a later approval', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-cancel-root-'));
  const outside = `${root}-outside`;
  await mkdir(outside);
  try {
    const runtime = createRuntime({
      root,
      policy: normalizePolicy({ categories: { outsideRoot: 'ask', dangerous: 'ask' } }),
      interactive: true
    });
    const requestId = 'req_sequential_cancel';
    const execution = runtime.dispatch('run_command', { command: 'git', args: ['--version'], cwd: outside }, { requestId });

    for (let index = 0; index < 50 && runtime.approvalQueue.getPending().length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const [scopeApproval] = runtime.approvalQueue.getPending();
    assert.equal(scopeApproval.category, 'outsideRoot');
    runtime.approvalQueue.resolve(scopeApproval.id, { action: 'allow', remember: null });

    assert.equal(runtime.cancel(requestId, 'Cloud request timed out between approvals'), true);
    await assert.rejects(execution, (error) => error?.code === 'REQUEST_CANCELLED');
    assert.equal(runtime.approvalQueue.getPending().length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});