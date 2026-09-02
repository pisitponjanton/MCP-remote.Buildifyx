import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    assert.equal(approval.requestId, 'req_cloud_123');
    assert.notEqual(approval.id, 'req_cloud_123');
    assert.match(approval.id, /^appr_/);
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

test('cancellation immediately after approval prevents a file write from starting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-cancel-after-approval-'));
  try {
    const target = path.join(root, 'cancelled.txt');
    const runtime = createRuntime({
      root,
      policy: normalizePolicy({ categories: { write: 'ask' } }),
      interactive: true
    });
    const requestId = 'req_cancel_after_approval';
    const execution = runtime.dispatch('write_file', { path: 'cancelled.txt', content: 'must-not-be-written' }, { requestId });

    for (let index = 0; index < 50 && runtime.approvalQueue.getPending().length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const [approval] = runtime.approvalQueue.getPending();
    assert.equal(approval.requestId, requestId);
    runtime.approvalQueue.resolve(approval.id, { action: 'allow', remember: null });
    assert.equal(runtime.cancel(requestId, 'Cancelled immediately after approval'), true);

    await assert.rejects(execution, (error) => error?.code === 'REQUEST_CANCELLED');
    await assert.rejects(access(target), (error) => error?.code === 'ENOENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancellation after a file side-effect commit point does not report a false cancellation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-cancel-commit-'));
  try {
    const target = path.join(root, 'committed.txt');
    const runtime = createRuntime({ root });
    let release;
    let committed;
    const gate = new Promise((resolve) => { release = resolve; });
    const committedGate = new Promise((resolve) => { committed = resolve; });
    runtime.services.write_file = async (input, context) => {
      context.commitSideEffect();
      committed();
      await gate;
      await writeFile(target, input.content);
      return { path: target, created: true };
    };

    const requestId = 'req_after_commit';
    const execution = runtime.dispatch('write_file', { path: 'committed.txt', content: 'committed' }, { requestId });
    await committedGate;
    assert.equal(runtime.cancel(requestId, 'Too late to cancel'), false);
    release();
    const result = await execution;
    assert.equal(result.created, true);
    assert.equal(await import('node:fs/promises').then(({ readFile }) => readFile(target, 'utf8')), 'committed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
