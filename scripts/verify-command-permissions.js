import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// No remote packages, real workspace changes, global installs or real deletions.
// The install fixture has no dependencies; its only lifecycle script writes a
// marker in the disposable project. npm config/cache are isolated and offline.
export async function runCommandMatrix({ agentDirectory = projectDirectory, namespace = 'local' } = {}) {
  const { createRuntime } = await import(pathToFileURL(path.join(agentDirectory, 'src/core/runtime.js')));
  const { createPolicyManager } = await import(pathToFileURL(path.join(agentDirectory, 'src/permissions/manager.js')));
  const { normalizePolicy } = await import(pathToFileURL(path.join(agentDirectory, 'src/permissions/policy.js')));
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-permission-matrix-')));
  const cases = [
    { id: 'git-version', command: 'git', args: ['--version'], categories: { write: 'deny', dangerous: 'deny', outsideRoot: 'deny' }, expected: 'completed' },
    { id: 'rg-files', command: 'rg', args: ['--files'], categories: { write: 'deny', dangerous: 'deny', outsideRoot: 'deny' }, expected: 'completed', optionalBinary: true },
    { id: 'rg-read-denied', command: 'rg', args: ['--files'], categories: { read: 'deny' }, expected: 'PERMISSION_DENIED' },
    { id: 'install-once', command: 'npm', install: true, approve: true, expected: 'completed', hook: true },
    { id: 'install-no-scripts', command: 'npm', install: true, noScripts: true, approve: true, expected: 'completed', hook: false },
    { id: 'install-rejected', command: 'npm', install: true, approve: false, expected: 'PERMISSION_DENIED', hook: false },
    { id: 'install-unattended', command: 'npm', install: true, unattended: true, expected: 'CONFIRMATION_REQUIRED', hook: false },
    { id: 'install-command-denied', command: 'npm', install: true, categories: { command: 'deny', dangerous: 'allow' }, expected: 'PERMISSION_DENIED', hook: false },
    { id: 'install-write-denied', command: 'npm', install: true, categories: { write: 'deny', dangerous: 'allow' }, expected: 'PERMISSION_DENIED', hook: false },
    { id: 'install-risk-denied', command: 'npm', install: true, exactRule: true, categories: { dangerous: 'deny' }, expected: 'PERMISSION_DENIED', hook: false },
    { id: 'project-build-once', command: 'npm', args: ['run', 'build'], approve: true, expected: 'completed' },
    { id: 'unknown-once', command: 'node', args: ['--version'], approve: true, expected: 'completed' },
    { id: 'unknown-rejected', command: 'node', args: ['--version'], approve: false, expected: 'PERMISSION_DENIED' },
    { id: 'unknown-unattended', command: 'node', args: ['--version'], unattended: true, expected: 'CONFIRMATION_REQUIRED' },
    { id: 'unknown-exact-rule', command: 'node', args: ['--version'], exactRule: true, unattended: true, expected: 'completed' },
    { id: 'outside-cwd-denied', command: 'node', args: ['--version'], outside: true, categories: { dangerous: 'allow' }, expected: 'PERMISSION_DENIED' },
    { id: 'destructive-rejected', command: 'rm', args: ['sentinel.txt'], approve: false, expected: 'PERMISSION_DENIED' },
    { id: 'rg-helper-rejected', command: 'rg', args: ['--pre', 'node', 'needle'], approve: false, expected: 'PERMISSION_DENIED' },
    { id: 'extended-install-rule-rejected', command: 'npm', args: ['install', '--global'], prefixRule: true, approve: false, expected: 'PERMISSION_DENIED' },
    { id: 'executable-path-rejected', command: '/bin/sh', args: ['-c', 'exit 0'], unattended: true, expected: 'INVALID_INPUT' },
    { id: 'shell-string-rejected', command: 'npm --version && node --version', args: [], unattended: true, expected: 'INVALID_INPUT' },
    { id: 'missing-executable', command: 'bdxa-permission-nonexistent-command', args: [], approve: true, expected: 'COMMAND_NOT_FOUND' }
  ];
  const rows = [];
  try {
    for (const entry of cases) {
      const root = path.join(base, entry.id);
      const outside = path.join(base, `${entry.id}-outside`);
      await mkdir(root);
      await mkdir(outside);
      await writeFile(path.join(root, 'sentinel.txt'), 'keep me');
      await writeFile(path.join(root, 'npm-config'), '');
      await writeFile(path.join(root, 'package.json'), JSON.stringify({
        name: 'bdxa-permission-fixture', version: '1.0.0', private: true,
        scripts: {
          postinstall: 'node -e "require(\'node:fs\').writeFileSync(\'install-hook-ran\', \'yes\')"',
          build: 'node -e "process.stdout.write(\'fixture build passed\')"'
        }
      }));
      const args = entry.install ? [
        'install', '--offline', '--no-audit', '--no-fund', '--package-lock=false',
        '--cache', path.join(root, 'npm-cache'), '--userconfig', path.join(root, 'npm-config'),
        '--globalconfig', path.join(root, 'npm-global-config'), ...(entry.noScripts ? ['--ignore-scripts'] : [])
      ] : entry.args;
      const policy = normalizePolicy({ categories: { outsideRoot: 'deny', ...entry.categories }, commandRules:
        entry.exactRule ? [{ executable: entry.command, argsPrefix: args, action: 'allow', exact: true, cwd: root }]
          : entry.prefixRule ? [{ executable: 'npm', argsPrefix: ['install'], action: 'allow' }] : [] });
      const policyManager = createPolicyManager(policy);
      const runtime = createRuntime({ root, namespace, policyManager, interactive: !entry.unattended });
      const prompts = [];
      const unsubscribe = runtime.approvalQueue?.subscribe(pending => {
        for (const request of pending) {
          if (prompts.some(item => item.id === request.id)) continue;
          prompts.push({ id: request.id, category: request.category, reason: request.evaluation?.reason,
            operationClass: request.evaluation?.operationClass });
          queueMicrotask(() => runtime.approvalQueue.resolve(request.id, { action: entry.approve ? 'allow' : 'deny', remember: null }));
        }
      });
      let outcome;
      let details;
      try {
        const result = await runtime.dispatch('run_command', {
          command: entry.command, args, cwd: entry.outside ? outside : '.', timeoutMs: 15000
        });
        outcome = result.exitCode === 0 && !result.timedOut ? 'completed' : `exit:${result.exitCode}`;
      } catch (error) {
        outcome = error.code ?? 'unexpected-error';
        details = error.details;
      } finally {
        unsubscribe?.();
        await runtime.stop();
      }
      const hookRan = await readFile(path.join(root, 'install-hook-ran'), 'utf8').then(() => true, () => false);
      assert.equal(await readFile(path.join(root, 'sentinel.txt'), 'utf8'), 'keep me', 'denied rm must not run');
      const unavailable = entry.optionalBinary && outcome === 'COMMAND_NOT_FOUND';
      rows.push({ id: entry.id, namespace, command: `${entry.command} ${(entry.install ? ['install', ...(entry.noScripts ? ['--ignore-scripts'] : []), '(offline fixture)'] : args).join(' ')}`,
        expected: entry.expected, outcome, prompts: prompts.map(({ id: _id, ...item }) => item),
        ...(details ? { details } : {}), ...(entry.install ? { hookRan } : {}),
        passed: (outcome === entry.expected || unavailable) && (entry.hook === undefined || hookRan === entry.hook),
        ...(unavailable ? { note: 'Authorization passed; ripgrep is not installed on this host.' } : {}) });
    }
    return rows;
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = await runCommandMatrix();
  console.table(rows.map(({ id, outcome, prompts, passed }) => ({ case: id, outcome, approvals: prompts.length, passed })));
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  if (rows.some(row => !row.passed)) process.exitCode = 1;
}
