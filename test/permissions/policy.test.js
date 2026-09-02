import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../../src/core/runtime.js';
import { createPolicyManager } from '../../src/permissions/manager.js';
import { evaluateRequest } from '../../src/permissions/evaluator.js';
import { normalizePolicy } from '../../src/permissions/policy.js';

async function withTemp(callback) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-policy-')));
  try { return await callback(base); } finally { await rm(base, { recursive: true, force: true }); }
}

async function waitForPending(queue) {
  for (let index = 0; index < 50; index += 1) {
    const pending = queue.getPending();
    if (pending.length) return pending[0];
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Timed out waiting for approval request.');
}

test('custom command can be approved once in restricted mode', async () => {
  await withTemp(async (root) => {
    const policyManager = createPolicyManager(normalizePolicy({
      commandRules: [{ executable: 'node', argsPrefix: ['--version'], action: 'ask' }]
    }), { filePath: path.join(root, 'policy.json') });
    const runtime = createRuntime({ root, policyManager, interactive: true });

    const execution = runtime.dispatch('run_command', { command: 'node', args: ['--version'] });
    const request = await waitForPending(runtime.approvalQueue);
    assert.equal(request.toolName, 'run_command');
    runtime.approvalQueue.resolve(request.id, { action: 'allow', remember: null });

    const result = await execution;
    assert.equal(result.exitCode, 0);
    assert.equal(result.mode, 'custom_rule');
  });
});

test('more specific command rule overrides broader rule and ASK reaches approval queue', async () => {
  await withTemp(async (root) => {
    const policyManager = createPolicyManager(normalizePolicy({
      commandRules: [
        { executable: 'node', argsPrefix: [], action: 'allow' },
        { executable: 'node', argsPrefix: ['--version'], action: 'ask' }
      ]
    }), { filePath: path.join(root, 'policy.json') });
    const runtime = createRuntime({ root, policyManager, interactive: true });

    const execution = runtime.dispatch('run_command', { command: 'node', args: ['--version'] });
    const request = await waitForPending(runtime.approvalQueue);
    assert.equal(request.toolName, 'run_command');
    assert.equal(request.evaluation.decision, 'ask');
    assert.equal(request.evaluation.rule.argsPrefix[0], '--version');
    runtime.approvalQueue.resolve(request.id, { action: 'allow', remember: null });

    const result = await execution;
    assert.equal(result.exitCode, 0);
    assert.equal(result.mode, 'custom_rule');
  });
});

test('outside-root file can be approved once and is logged as outside scope', async () => {
  await withTemp(async (base) => {
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside.txt');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(root));
    await writeFile(outside, 'outside');

    const policyManager = createPolicyManager(normalizePolicy({
      categories: { outsideRoot: 'ask' }
    }), { filePath: path.join(base, 'policy.json') });
    const runtime = createRuntime({ root, policyManager, interactive: true });

    const reading = runtime.dispatch('read_file', { path: outside });
    const request = await waitForPending(runtime.approvalQueue);
    assert.equal(request.pathInfo.scope, 'outside');
    runtime.approvalQueue.resolve(request.id, { action: 'allow', remember: null });

    const result = await reading;
    assert.equal(result.content, 'outside');
    assert.equal(result.scope, 'outside');
  });
});

test('audit events redact write content while preserving tool metadata', async () => {
  await withTemp(async (root) => {
    const runtime = createRuntime({ root, interactive: true });
    await runtime.dispatch('write_file', { path: 'secret.txt', content: 'super-secret-value' });
    const started = runtime.eventBus.getHistory().find((event) => event.type === 'tool.started' && event.tool === 'write_file');
    assert.equal(started.input.path, 'secret.txt');
    assert.equal(started.input.content, '<18 chars>');
    assert.equal(runtime.eventBus.getHistory().some((event) => event.type === 'resource.accessed' && event.operation === 'create'), true);
  });
});

test('auto policy asks before script-capable package-manager and mutating git commands', () => {
  const policy = normalizePolicy();
  const askCases = [
    { command: 'npm', args: ['run', 'build'] },
    { command: 'npm', args: ['install'] },
    { command: 'npm', args: ['config', 'list'] },
    { command: 'pnpm', args: [] },
    { command: 'pnpm', args: ['exec', 'node', '--version'] },
    { command: 'yarn', args: [] },
    { command: 'yarn', args: ['dlx', 'example'] },
    { command: 'git', args: ['config', 'alias.shell', '!node -e process.exit(0)'] },
    { command: 'git', args: ['checkout', '-b', 'feature'] },
    { command: 'git', args: ['diff', '--no-index', '/etc/hosts', '/etc/passwd'] },
    { command: 'git', args: ['cat-file', '--filters', 'HEAD:README.md'] },
    { command: 'git', args: ['grep', '--open-files-in-pager=cat', 'needle'] }
  ];
  for (const input of askCases) {
    const evaluation = evaluateRequest({ toolName: 'run_command', input, policy });
    assert.equal(evaluation.decision, 'ask', `${input.command} ${input.args.join(' ')} should require approval`);
    assert.equal(evaluation.category, 'dangerous');
  }

  const safeCases = [
    { command: 'npm', args: ['view', 'react', 'version'] },
    { command: 'npm', args: ['config', 'get', 'registry'] },
    { command: 'git', args: ['status', '--short'] },
    { command: 'git', args: ['branch', '--show-current'] }
  ];

  for (const input of safeCases) {
    const evaluation = evaluateRequest({ toolName: 'run_command', input, policy });
    assert.equal(evaluation.decision, 'allow', `${input.command} ${input.args.join(' ')} should stay in restricted auto mode`);
    assert.equal(evaluation.category, 'command');
  }
});

test('dangerous git options cannot extend a broader allow rule', () => {
  const broadPolicy = normalizePolicy({
    commandRules: [{ executable: 'git', argsPrefix: ['diff'], action: 'allow' }]
  });
  const extended = evaluateRequest({
    toolName: 'run_command',
    input: { command: 'git', args: ['diff', '--ext-diff'] },
    policy: broadPolicy
  });
  assert.equal(extended.decision, 'ask');
  assert.equal(extended.category, 'dangerous');

  const exactPolicy = normalizePolicy({
    commandRules: [{ executable: 'git', argsPrefix: ['diff', '--ext-diff'], action: 'allow' }]
  });
  const exact = evaluateRequest({
    toolName: 'run_command',
    input: { command: 'git', args: ['diff', '--ext-diff'] },
    policy: exactPolicy
  });
  assert.equal(exact.decision, 'allow');
  assert.equal(exact.category, 'commandRule');

  const extendedExact = evaluateRequest({
    toolName: 'run_command',
    input: { command: 'git', args: ['diff', '--ext-diff', '--stat'] },
    policy: exactPolicy
  });
  assert.equal(extendedExact.decision, 'ask');
  assert.equal(extendedExact.category, 'dangerous');
});

test('outside-root permission cannot bypass a denied write operation', async () => {
  await withTemp(async (base) => {
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    await import('node:fs/promises').then(({ mkdir }) => Promise.all([mkdir(root), mkdir(outside)]));
    const policyManager = createPolicyManager(normalizePolicy({
      categories: { write: 'deny', outsideRoot: 'ask' }
    }), { filePath: path.join(base, 'policy.json') });
    const runtime = createRuntime({ root, policyManager, interactive: true });

    await assert.rejects(
      () => runtime.dispatch('write_file', { path: path.join(outside, 'blocked.txt'), content: 'blocked' }),
      (error) => error?.code === 'PERMISSION_DENIED' && error?.details?.category === 'write'
    );
    assert.equal(runtime.approvalQueue.getPending().length, 0);
  });
});

test('outside-root and dangerous command permissions require distinct approvals', async () => {
  await withTemp(async (base) => {
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    await import('node:fs/promises').then(({ mkdir }) => Promise.all([mkdir(root), mkdir(outside)]));
    const policyManager = createPolicyManager(normalizePolicy({
      categories: { outsideRoot: 'ask', dangerous: 'ask' }
    }), { filePath: path.join(base, 'policy.json') });
    const runtime = createRuntime({ root, policyManager, interactive: true });
    const requestId = 'req_two_permission_gates';

    const execution = runtime.dispatch('run_command', { command: 'git', args: ['--version'], cwd: outside }, { requestId });
    const scopeRequest = await waitForPending(runtime.approvalQueue);
    assert.equal(scopeRequest.category, 'outsideRoot');
    assert.equal(scopeRequest.requestId, requestId);
    assert.notEqual(scopeRequest.id, requestId);
    runtime.approvalQueue.resolve(scopeRequest.id, { action: 'allow', remember: null });

    const commandRequest = await waitForPending(runtime.approvalQueue);
    assert.equal(commandRequest.category, 'dangerous');
    assert.equal(commandRequest.requestId, requestId);
    assert.notEqual(commandRequest.id, scopeRequest.id);
    assert.equal(runtime.approvalQueue.resolve(scopeRequest.id, { action: 'allow', remember: null }), false);
    assert.equal(runtime.approvalQueue.getPending()[0].id, commandRequest.id);
    runtime.approvalQueue.resolve(commandRequest.id, { action: 'allow', remember: null });

    const result = await execution;
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /git version/i);
  });
});
test('outside-root approval does not unlock an arbitrary executable', async () => {
  await withTemp(async (base) => {
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    await import('node:fs/promises').then(({ mkdir }) => Promise.all([mkdir(root), mkdir(outside)]));
    const policyManager = createPolicyManager(normalizePolicy({
      categories: { command: 'allow', outsideRoot: 'ask' }
    }), { filePath: path.join(base, 'policy.json') });
    const runtime = createRuntime({ root, policyManager, interactive: true });

    const execution = runtime.dispatch('run_command', { command: 'node', args: ['--version'], cwd: outside });
    const scopeRequest = await waitForPending(runtime.approvalQueue);
    assert.equal(scopeRequest.category, 'outsideRoot');
    runtime.approvalQueue.resolve(scopeRequest.id, { action: 'allow', remember: null });

    await assert.rejects(execution, /Command is not allowed in restricted mode: node/);
  });
});