import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkspacePlanService } from '../../src/workspace-plan/service.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-service-workspace-'));
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-service-home-'));
  let tick = 0;
  const service = createWorkspacePlanService({
    root,
    homeDirectory,
    taskId: () => 'task_service',
    now: () => `2026-09-20T08:00:0${tick++}.000Z`
  });
  return {
    root,
    homeDirectory,
    service,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
      await rm(homeDirectory, { recursive: true, force: true });
    }
  };
}

function draft() {
  return {
    title: 'Workspace plan service',
    taskGoal: 'Keep task direction stable across chats.',
    scope: ['Implement lifecycle service.'],
    constraints: ['Review diff must be last.'],
    acceptanceCriteria: ['Revision conflicts fail closed.'],
    phases: [
      { type: 'implementation', title: 'Implement', goal: 'Implement service behavior.' },
      { type: 'test', title: 'Test', goal: 'Test service behavior.' }
    ]
  };
}

test('service creates and reads one active task with authoritative intent', async () => {
  const f = await fixture();
  try {
    const created = await f.service.createWorkspacePlan(draft());
    assert.equal(created.taskId, 'task_service');
    assert.equal(created.taskGoal, 'Keep task direction stable across chats.');
    assert.equal(created.phases.at(-1).type, 'review_diff');
    assert.deepEqual(await f.service.getWorkspacePlan(), created);
  } finally {
    await f.cleanup();
  }
});

test('explicit intent update increments revision while preserving execution state', async () => {
  const f = await fixture();
  try {
    const created = await f.service.createWorkspacePlan(draft());
    const updated = await f.service.updateWorkspacePlanIntent({
      expectedRevision: created.revision,
      taskGoal: 'Updated authoritative task goal.'
    });
    assert.equal(updated.revision, 2);
    assert.equal(updated.taskGoal, 'Updated authoritative task goal.');
    assert.equal(updated.currentPhase, created.currentPhase);
    assert.deepEqual(updated.phases, created.phases);
  } finally {
    await f.cleanup();
  }
});

test('stale concurrent mutations cannot silently overwrite the newer plan', async () => {
  const f = await fixture();
  try {
    const created = await f.service.createWorkspacePlan(draft());
    const results = await Promise.allSettled([
      f.service.updateWorkspacePlanIntent({
        expectedRevision: created.revision,
        taskGoal: 'Goal A'
      }),
      f.service.updateWorkspacePlanIntent({
        expectedRevision: created.revision,
        taskGoal: 'Goal B'
      })
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected?.reason?.code, 'PLAN_REVISION_CONFLICT');
    assert.equal((await f.service.getWorkspacePlan())?.revision, 2);
  } finally {
    await f.cleanup();
  }
});

test('normal phase completion advances deterministically', async () => {
  const f = await fixture();
  try {
    const created = await f.service.createWorkspacePlan(draft());
    const result = await f.service.completeWorkspacePhase({
      expectedRevision: created.revision,
      phaseId: created.currentPhase
    });
    assert.equal(result.completed, false);
    assert.equal(result.plan.revision, 2);
    assert.equal(result.plan.currentPhase, 2);
    assert.equal(result.plan.phases[0].status, 'completed');
    assert.equal(result.plan.phases[1].status, 'in_progress');
  } finally {
    await f.cleanup();
  }
});

test('failed review inserts fix_review and keeps review_diff final and pending', async () => {
  const f = await fixture();
  try {
    let plan = await f.service.createWorkspacePlan(draft());
    plan = (await f.service.completeWorkspacePhase({
      expectedRevision: plan.revision,
      phaseId: plan.currentPhase
    })).plan;
    plan = (await f.service.completeWorkspacePhase({
      expectedRevision: plan.revision,
      phaseId: plan.currentPhase
    })).plan;

    assert.equal(plan.phases.find((phase) => phase.id === plan.currentPhase)?.type, 'review_diff');

    const failed = await f.service.completeWorkspacePhase({
      expectedRevision: plan.revision,
      phaseId: plan.currentPhase,
      review: {
        passed: false,
        findings: ['Missing regression coverage for concurrent updates.']
      }
    });

    assert.equal(failed.completed, false);
    assert.equal(failed.reviewPassed, false);
    assert.equal(failed.plan.phases.at(-1).type, 'review_diff');
    assert.equal(failed.plan.phases.at(-1).status, 'pending');
    const fix = failed.plan.phases.find((phase) => phase.id === failed.plan.currentPhase);
    assert.equal(fix?.type, 'fix_review');
    assert.match(fix?.goal ?? '', /Missing regression coverage/);
  } finally {
    await f.cleanup();
  }
});

test('fix_review completion returns to review_diff and successful review deletes the plan', async () => {
  const f = await fixture();
  try {
    let plan = await f.service.createWorkspacePlan(draft());
    while (plan.phases.find((phase) => phase.id === plan.currentPhase)?.type !== 'review_diff') {
      plan = (await f.service.completeWorkspacePhase({
        expectedRevision: plan.revision,
        phaseId: plan.currentPhase
      })).plan;
    }

    const failed = await f.service.completeWorkspacePhase({
      expectedRevision: plan.revision,
      phaseId: plan.currentPhase,
      review: { passed: false, findings: ['Fix this issue.'] }
    });
    const afterFix = await f.service.completeWorkspacePhase({
      expectedRevision: failed.plan.revision,
      phaseId: failed.plan.currentPhase
    });
    assert.equal(
      afterFix.plan.phases.find((phase) => phase.id === afterFix.plan.currentPhase)?.type,
      'review_diff'
    );

    const completed = await f.service.completeWorkspacePhase({
      expectedRevision: afterFix.plan.revision,
      phaseId: afterFix.plan.currentPhase,
      review: { passed: true, findings: [] }
    });
    assert.equal(completed.completed, true);
    assert.equal(completed.plan, null);
    assert.equal(await f.service.getWorkspacePlan(), null);
  } finally {
    await f.cleanup();
  }
});

test('clear requires the current revision and removes an abandoned task explicitly', async () => {
  const f = await fixture();
  try {
    const created = await f.service.createWorkspacePlan(draft());
    await assert.rejects(
      f.service.clearWorkspacePlan({
        expectedRevision: created.revision + 1,
        reason: 'Reset task'
      }),
      (error) => error?.code === 'PLAN_REVISION_CONFLICT'
    );

    const cleared = await f.service.clearWorkspacePlan({
      expectedRevision: created.revision,
      reason: 'User abandoned the task.'
    });
    assert.equal(cleared.cleared, true);
    assert.equal(cleared.clearedTask.reason, 'User abandoned the task.');
    assert.equal(await f.service.getWorkspacePlan(), null);
  } finally {
    await f.cleanup();
  }
});

test('oversized failed-review findings are rejected before plan mutation', async () => {
  const f = await fixture();
  try {
    let plan = await f.service.createWorkspacePlan(draft());
    while (plan.phases.find((phase) => phase.id === plan.currentPhase)?.type !== 'review_diff') {
      plan = (await f.service.completeWorkspacePhase({
        expectedRevision: plan.revision,
        phaseId: plan.currentPhase
      })).plan;
    }

    const before = await f.service.getWorkspacePlan();
    await assert.rejects(
      f.service.completeWorkspacePhase({
        expectedRevision: plan.revision,
        phaseId: plan.currentPhase,
        review: {
          passed: false,
          findings: ['A'.repeat(5000), 'B'.repeat(5000)]
        }
      }),
      (error) => error?.name === 'ZodError'
    );

    assert.deepEqual(await f.service.getWorkspacePlan(), before);
  } finally {
    await f.cleanup();
  }
});

test('largest practical failed-review finding still creates a valid fix_review phase', async () => {
  const f = await fixture();
  try {
    let plan = await f.service.createWorkspacePlan(draft());
    while (plan.phases.find((phase) => phase.id === plan.currentPhase)?.type !== 'review_diff') {
      plan = (await f.service.completeWorkspacePhase({
        expectedRevision: plan.revision,
        phaseId: plan.currentPhase
      })).plan;
    }

    const failed = await f.service.completeWorkspacePhase({
      expectedRevision: plan.revision,
      phaseId: plan.currentPhase,
      review: { passed: false, findings: ['A'.repeat(7000)] }
    });
    const fix = failed.plan.phases.find((phase) => phase.id === failed.plan.currentPhase);
    assert.equal(fix?.type, 'fix_review');
    assert.equal((fix?.goal.length ?? 0) <= 8000, true);
  } finally {
    await f.cleanup();
  }
});

test('repeated failed reviews reuse the existing fix_review phase instead of growing the plan', async () => {
  const f = await fixture();
  try {
    let plan = await f.service.createWorkspacePlan(draft());
    while (plan.phases.find((phase) => phase.id === plan.currentPhase)?.type !== 'review_diff') {
      plan = (await f.service.completeWorkspacePhase({
        expectedRevision: plan.revision,
        phaseId: plan.currentPhase
      })).plan;
    }

    const firstFailure = await f.service.completeWorkspacePhase({
      expectedRevision: plan.revision,
      phaseId: plan.currentPhase,
      review: { passed: false, findings: ['First blocker.'] }
    });
    const firstFix = firstFailure.plan.phases.find((phase) => phase.id === firstFailure.plan.currentPhase);
    const firstCount = firstFailure.plan.phases.length;
    assert.equal(firstFix?.type, 'fix_review');

    const backToReview = await f.service.completeWorkspacePhase({
      expectedRevision: firstFailure.plan.revision,
      phaseId: firstFailure.plan.currentPhase
    });
    const secondFailure = await f.service.completeWorkspacePhase({
      expectedRevision: backToReview.plan.revision,
      phaseId: backToReview.plan.currentPhase,
      review: { passed: false, findings: ['Second blocker.'] }
    });
    const reusedFix = secondFailure.plan.phases.find((phase) => phase.id === secondFailure.plan.currentPhase);

    assert.equal(secondFailure.plan.phases.length, firstCount);
    assert.equal(reusedFix?.id, firstFix?.id);
    assert.equal(reusedFix?.type, 'fix_review');
    assert.match(reusedFix?.goal ?? '', /Second blocker/);
    assert.equal(secondFailure.plan.phases.at(-1).type, 'review_diff');
    assert.equal(secondFailure.plan.phases.at(-1).status, 'pending');
  } finally {
    await f.cleanup();
  }
});