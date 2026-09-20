import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkspacePlanService } from '../../src/workspace-plan/service.js';

function draft() {
  return {
    title: 'Recovery task',
    taskGoal: 'Resume the exact same task after the Agent service is recreated.',
    scope: ['Persist task intent and execution progress by workspace identity.'],
    constraints: ['Do not bind persistence to instanceId or chat session.'],
    acceptanceCriteria: ['A recreated service reads the same revision and current phase.'],
    phases: [
      { type: 'implementation', title: 'Implement', goal: 'Implement recovery.' },
      { type: 'test', title: 'Verify', goal: 'Verify recovery.' }
    ]
  };
}

test('recreated Agent service resumes the same workspace task and progress', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-recovery-workspace-'));
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-recovery-home-'));
  let tick = 0;
  const clock = () => `2026-09-20T09:00:0${tick++}.000Z`;

  try {
    const firstProcess = createWorkspacePlanService({
      root,
      homeDirectory,
      taskId: () => 'task_recovery',
      now: clock
    });
    let plan = await firstProcess.createWorkspacePlan(draft());
    plan = (await firstProcess.completeWorkspacePhase({
      expectedRevision: plan.revision,
      phaseId: plan.currentPhase
    })).plan;

    assert.equal(plan.revision, 2);
    assert.equal(plan.currentPhase, 2);

    // A fresh service object models an Agent process/instance being recreated.
    const recreatedProcess = createWorkspacePlanService({
      root: path.join(root, '.'),
      homeDirectory,
      taskId: () => 'unused_new_instance_task_id',
      now: clock
    });
    const recovered = await recreatedProcess.getWorkspacePlan();

    assert.equal(recovered?.taskId, 'task_recovery');
    assert.equal(recovered?.revision, 2);
    assert.equal(recovered?.currentPhase, 2);
    assert.equal(recovered?.taskGoal, draft().taskGoal);
    assert.deepEqual(recovered?.scope, draft().scope);
    assert.deepEqual(recovered?.constraints, draft().constraints);
    assert.deepEqual(recovered?.acceptanceCriteria, draft().acceptanceCriteria);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test('successful final review stays deleted after the Agent service is recreated', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-delete-recovery-workspace-'));
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-delete-recovery-home-'));

  try {
    const service = createWorkspacePlanService({
      root,
      homeDirectory,
      taskId: () => 'task_delete_recovery',
      now: () => '2026-09-20T09:10:00.000Z'
    });
    let plan = await service.createWorkspacePlan({
      ...draft(),
      phases: [
        { type: 'implementation', title: 'Implement', goal: 'Implement final deletion.' }
      ]
    });
    plan = (await service.completeWorkspacePhase({
      expectedRevision: plan.revision,
      phaseId: plan.currentPhase
    })).plan;

    const completed = await service.completeWorkspacePhase({
      expectedRevision: plan.revision,
      phaseId: plan.currentPhase,
      review: { passed: true, findings: [] }
    });
    assert.equal(completed.completed, true);

    const recreatedProcess = createWorkspacePlanService({
      root,
      homeDirectory,
      taskId: () => 'unused',
      now: () => '2026-09-20T09:11:00.000Z'
    });
    assert.equal(await recreatedProcess.getWorkspacePlan(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(homeDirectory, { recursive: true, force: true });
  }
});
