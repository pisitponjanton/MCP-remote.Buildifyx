import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../../src/core/runtime.js';
import { createPermissionController } from '../../src/permissions/controller.js';
import { createPolicyManager } from '../../src/permissions/manager.js';
import { evaluateRequest } from '../../src/permissions/evaluator.js';
import { normalizePolicy } from '../../src/permissions/policy.js';
import { createCommandService } from '../../src/services/commands.js';
import { publicToolError } from '../../src/core/errors.js';

async function fixture(callback) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-command-consent-')));
  try { await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function pending(queue) {
  for (let i = 0; i < 250; i++) {
    if (queue.getPending().length) return queue.getPending()[0];
    await new Promise(resolve => setTimeout(resolve, 4));
  }
  throw new Error('Approval did not appear');
}

test('remembered approval persists exact argv and canonical cwd, not a growing prefix or another directory', async () => fixture(async root => {
  const sub = path.join(root, 'sub');
  await mkdir(sub);
  const filePath = path.join(root, 'policy.json');
  const manager = createPolicyManager(normalizePolicy({ categories: { outsideRoot: 'deny' } }), { filePath });
  const runtime = createRuntime({ root, policyManager: manager, interactive: true });
  try {
    const first = runtime.dispatch('run_command', { command: 'node', args: ['--version'] });
    const approval = await pending(runtime.approvalQueue);
    runtime.approvalQueue.resolve(approval.id, { action: 'allow', remember: 'command' });
    assert.equal((await first).exitCode, 0);
    const stored = JSON.parse(await readFile(filePath, 'utf8')).commandRules[0];
    assert.deepEqual(stored, { executable: 'node', argsPrefix: ['--version'], exact: true, cwd: root, action: 'allow' });
    assert.equal((await runtime.dispatch('run_command', { command: 'node', args: ['--version'] })).exitCode, 0);
    for (const input of [
      { command: 'node', args: ['--version', '--help'] },
      { command: 'node', args: ['--version'], cwd: sub }
    ]) {
      const execution = runtime.dispatch('run_command', input);
      const next = await pending(runtime.approvalQueue);
      runtime.approvalQueue.resolve(next.id, { action: 'deny', remember: null });
      await assert.rejects(execution, { code: 'PERMISSION_DENIED' });
    }
    const reloaded = createPolicyManager(undefined, { filePath });
    assert.equal(evaluateRequest({ toolName: 'run_command', input: { command: 'node', args: ['--version'], cwd: root }, policy: reloaded.get() }).decision, 'allow');
    await manager.removeCommandRule(0);
    assert.equal(manager.get().commandRules.length, 0);
  } finally { await runtime.stop(); }
}));

test('Allow once never creates a persisted rule and the next invocation asks again', async () => fixture(async root => {
  const runtime = createRuntime({ root, interactive: true });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const execution = runtime.dispatch('run_command', { command: 'node', args: ['--version'] });
      const request = await pending(runtime.approvalQueue);
      runtime.approvalQueue.resolve(request.id, { action: 'allow', remember: null });
      const result = await execution;
      assert.equal(result.exitCode, 0);
      assert.equal(result.authorization.source, 'approval');
      assert.equal(runtime.policyManager.get().commandRules.length, 0);
    }
  } finally { await runtime.stop(); }
}));

test('command, read and sensitive Deny cannot be bypassed by an exact allow rule', () => {
  for (const [category, input] of [
    ['command', { command: 'node', args: ['--version'] }],
    ['read', { command: 'rg', args: ['--files'] }],
    ['write', { command: 'npm', args: ['install'] }],
    ['dangerous', { command: 'npm', args: ['install'] }]
  ]) {
    const policy = normalizePolicy({ categories: { [category]: 'deny' },
      commandRules: [{ executable: input.command, argsPrefix: input.args, exact: true, action: 'allow' }] });
    const evaluation = evaluateRequest({ toolName: 'run_command', input, policy });
    assert.equal(evaluation.decision, 'deny');
    assert.equal(evaluation.category, category);
  }
});

test('revocation while approval is pending prevents execution and remembering a new grant', async () => fixture(async root => {
  const runtime = createRuntime({ root, interactive: true });
  try {
    const execution = runtime.dispatch('run_command', { command: 'node', args: ['--version'] });
    const request = await pending(runtime.approvalQueue);
    await runtime.policyManager.setCategory('command', 'deny');
    runtime.approvalQueue.resolve(request.id, { action: 'allow', remember: 'command' });
    await assert.rejects(execution, { code: 'PERMISSION_DENIED' });
    assert.equal(runtime.policyManager.get().commandRules.length, 0);
    assert.equal(runtime.eventBus.getHistory().some(event => event.type === 'process.started'), false);
  } finally { await runtime.stop(); }
}));

test('removing an allow rule after authorization prevents the process from spawning', async () => fixture(async root => {
  const input = { command: 'node', args: ['-e', "require('node:fs').writeFileSync('must-not-exist','bad')"], cwd: '.' };
  const manager = createPolicyManager(normalizePolicy({ commandRules: [{ executable: 'node', argsPrefix: input.args, action: 'allow', exact: true, cwd: root }] }));
  const authorize = createPermissionController({ root, policyManager: manager });
  const context = await authorize('run_command', input, 'revoked');
  await manager.removeCommandRule(0);
  await assert.rejects(createCommandService({ root })(input, context), { code: 'PERMISSION_DENIED' });
  await assert.rejects(access(path.join(root, 'must-not-exist')), { code: 'ENOENT' });
}));

test('an approved invocation cannot be reused for changed arguments or a changed directory', async () => fixture(async root => {
  const input = { command: 'node', args: ['--version'] };
  const manager = createPolicyManager(normalizePolicy({ commandRules: [{ executable: 'node', argsPrefix: input.args, action: 'allow' }] }));
  const context = await createPermissionController({ root, policyManager: manager })('run_command', input, 'bound');
  const run = createCommandService({ root });
  await assert.rejects(run({ ...input, args: ['-e', 'process.exit(0)'] }, context), { code: 'PERMISSION_DENIED' });
  const other = path.join(root, 'other');
  await mkdir(other);
  await assert.rejects(run(input, { ...context, pathInfo: { resolved: other } }), { code: 'PERMISSION_DENIED' });
}));

test('revoking an additional root before spawn invalidates an approved cwd', async () => fixture(async base => {
  const root = path.join(base, 'root');
  const extra = path.join(base, 'extra');
  await mkdir(root); await mkdir(extra);
  const manager = createPolicyManager(normalizePolicy({ categories: { outsideRoot: 'deny' }, additionalRoots: [extra] }));
  const input = { command: 'git', args: ['--version'], cwd: extra };
  const context = await createPermissionController({ root, policyManager: manager })('run_command', input, 'root-revoked');
  await manager.removeRoot(0);
  await assert.rejects(createCommandService({ root })(input, context), { code: 'PERMISSION_DENIED' });
}));

test('unrelated permission changes do not invalidate an approved command', async () => fixture(async root => {
  const manager = createPolicyManager(normalizePolicy());
  const input = { command: 'git', args: ['--version'] };
  const context = await createPermissionController({ root, policyManager: manager })('run_command', input, 'unrelated');
  await manager.setCategory('write', 'deny');
  await manager.setCategory('dangerous', 'deny');
  await manager.setCategory('outsideRoot', 'deny');
  const result = await createCommandService({ root })(input, context);
  assert.equal(result.exitCode, 0);
  assert.equal(result.mode, 'restricted');
  assert.equal(result.authorization.source, 'policy');
}));

test('an omitted cwd is canonicalized even when the workspace is opened through a symlink', { skip: process.platform === 'win32' }, async () => fixture(async base => {
  const root = path.join(base, 'real');
  const alias = path.join(base, 'alias');
  await mkdir(root); await symlink(root, alias);
  const runtime = createRuntime({ root: alias, interactive: false });
  try {
    assert.equal((await runtime.dispatch('run_command', { command: 'git', args: ['--version'] })).exitCode, 0);
  } finally { await runtime.stop(); }
}));

test('downgrading outsideRoot from Allow to Ask invalidates an already authorized outside cwd', async () => fixture(async base => {
  const root = path.join(base, 'root'); const outside = path.join(base, 'outside');
  await mkdir(root); await mkdir(outside);
  const manager = createPolicyManager(normalizePolicy({ categories: { outsideRoot: 'allow' } }));
  const input = { command: 'git', args: ['--version'], cwd: outside };
  const context = await createPermissionController({ root, policyManager: manager })('run_command', input, 'scope-downgrade');
  await manager.setCategory('outsideRoot', 'ask');
  await assert.rejects(createCommandService({ root })(input, context), { code: 'PERMISSION_DENIED' });
}));

const hasRipgrep = !spawnSync('rg', ['--no-config', '--version']).error;
test('automatic rg --files disables hostile config and does not follow an external directory symlink', { skip: !hasRipgrep || process.platform === 'win32' }, async () => fixture(async base => {
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  await mkdir(root); await mkdir(outside);
  await writeFile(path.join(root, 'visible.txt'), 'visible');
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
  await symlink(outside, path.join(root, 'linked'));
  const config = path.join(base, 'ripgrep-config');
  await writeFile(config, '--follow\n');
  const previous = process.env.RIPGREP_CONFIG_PATH;
  process.env.RIPGREP_CONFIG_PATH = config;
  const runtime = createRuntime({ root, interactive: false, policy: normalizePolicy({ categories: { dangerous: 'deny', outsideRoot: 'deny', write: 'deny' } }) });
  try {
    const result = await runtime.dispatch('run_command', { command: 'rg', args: ['--files'] });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /visible.txt/);
    assert.doesNotMatch(result.stdout, /secret.txt/);
    await assert.rejects(runtime.dispatch('run_command', { command: 'rg', args: ['--files', '--follow'] }), { code: 'PERMISSION_DENIED' });
  } finally {
    if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
    else process.env.RIPGREP_CONFIG_PATH = previous;
    await runtime.stop();
  }
}));

test('public permission diagnostics expose only enumerated recovery hints, never argv or paths', () => {
  const failure = publicToolError(Object.assign(new Error('secret argument'), { code: 'PERMISSION_DENIED' }));
  assert.doesNotMatch(JSON.stringify(failure), /secret argument/);
  const runtime = createPermissionController({ root: '.', policyManager: createPolicyManager(normalizePolicy({ categories: { command: 'deny' } })) });
  return assert.rejects(runtime('run_command', { command: 'node', args: ['--version'] }, 'diagnostic'), error => {
    assert.deepEqual(publicToolError(error).details, { category: 'command', toolName: 'run_command', operationClass: 'unclassified', gate: 'localPolicy', nextAction: 'reviewLocalPolicy' });
    return true;
  });
});
