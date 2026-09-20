import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../../src/core/runtime.js';

async function withRuntime(policy, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-mcp-workspace-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-mcp-home-'));
  const previousHome = process.env.BUILDFYX_HOME;
  process.env.BUILDFYX_HOME = home;
  const runtime = createRuntime({ root, policy, interactive: false });

  try {
    await run(runtime);
  } finally {
    await runtime.stop('test complete', { force: true });
    if (previousHome === undefined) delete process.env.BUILDFYX_HOME;
    else process.env.BUILDFYX_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

const allowPolicy = {
  categories: {
    read: 'allow',
    write: 'allow',
    command: 'allow',
    dangerous: 'deny',
    outsideRoot: 'deny'
  }
};

test('workspace plan MCP services dispatch through the normal runtime', async () => {
  await withRuntime(allowPolicy, async (runtime) => {
    const created = await runtime.dispatch('create_workspace_plan', {
      title: 'Runtime plan',
      taskGoal: 'Resume this task safely across chats.',
      scope: ['Expose plan tools through runtime.'],
      constraints: ['Review diff remains final.'],
      acceptanceCriteria: ['Runtime can read and advance the plan.'],
      phases: [
        { type: 'implementation', title: 'Implement', goal: 'Wire runtime tools.' }
      ]
    });

    assert.equal(created.revision, 1);
    assert.equal(created.phases.at(-1).type, 'review_diff');

    const read = await runtime.dispatch('get_workspace_plan', {});
    assert.equal(read.plan?.taskId, created.taskId);
    assert.equal(read.plan?.taskGoal, created.taskGoal);

    const advanced = await runtime.dispatch('complete_workspace_phase', {
      expectedRevision: created.revision,
      phaseId: created.currentPhase
    });
    assert.equal(advanced.plan?.revision, 2);
    assert.equal(
      advanced.plan?.phases.find((phase) => phase.id === advanced.plan.currentPhase)?.type,
      'review_diff'
    );
  });
});

test('workspace plan mutations obey the existing write permission gate', async () => {
  await withRuntime({
    categories: {
      read: 'allow',
      write: 'deny',
      command: 'allow',
      dangerous: 'deny',
      outsideRoot: 'deny'
    }
  }, async (runtime) => {
    const empty = await runtime.dispatch('get_workspace_plan', {});
    assert.deepEqual(empty, { plan: null });

    await assert.rejects(
      runtime.dispatch('create_workspace_plan', {
        title: 'Denied plan',
        taskGoal: 'This write must be denied.',
        scope: ['Test permissions.'],
        constraints: ['Respect write policy.'],
        acceptanceCriteria: ['Creation is denied.'],
        phases: [
          { type: 'implementation', title: 'Implement', goal: 'Should not run.' }
        ]
      }),
      (error) => error?.code === 'PERMISSION_DENIED'
    );
  });
});
test('workspace plan mutation commits only after revision validation succeeds', async () => {
  await withRuntime(allowPolicy, async (runtime) => {
    const created = await runtime.dispatch('create_workspace_plan', {
      title: 'Commit boundary plan',
      taskGoal: 'Keep commit semantics aligned with durable side effects.',
      scope: ['Validate before committing.'],
      constraints: ['Stale revisions must not commit.'],
      acceptanceCriteria: ['Rejected mutations never cross the commit point.'],
      phases: [{ type: 'implementation', title: 'Implement', goal: 'Implement commit boundary.' }]
    });

    let commits = 0;
    await assert.rejects(
      runtime.services.update_workspace_plan_intent({
        expectedRevision: created.revision + 1,
        taskGoal: 'Stale change'
      }, {
        throwIfCancelled() {},
        commitSideEffect() { commits += 1; }
      }),
      (error) => error?.code === 'PLAN_REVISION_CONFLICT'
    );
    assert.equal(commits, 0);
  });
});

test('cancellation at the workspace plan commit boundary prevents the durable write', async () => {
  await withRuntime(allowPolicy, async (runtime) => {
    const cancellation = Object.assign(new Error('Cancelled before plan commit'), { code: 'REQUEST_CANCELLED' });

    await assert.rejects(
      runtime.services.create_workspace_plan({
        title: 'Cancelled plan',
        taskGoal: 'This plan must not be persisted.',
        scope: ['Test commit cancellation.'],
        constraints: ['No write after cancellation.'],
        acceptanceCriteria: ['Plan remains absent.'],
        phases: [{ type: 'implementation', title: 'Implement', goal: 'Should not persist.' }]
      }, {
        throwIfCancelled() {},
        commitSideEffect() { throw cancellation; }
      }),
      (error) => error?.code === 'REQUEST_CANCELLED'
    );

    assert.deepEqual(
      await runtime.services.get_workspace_plan({}, { throwIfCancelled() {} }),
      { plan: null }
    );
  });
});