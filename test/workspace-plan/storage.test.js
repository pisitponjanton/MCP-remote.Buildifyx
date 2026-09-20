import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildWorkspacePlanDocument } from '../../src/workspace-plan/contract.js';
import {
  createWorkspacePlanFile,
  deleteWorkspacePlanFile,
  loadWorkspacePlan,
  replaceWorkspacePlanFile,
  workspacePlanStorageLocation
} from '../../src/workspace-plan/storage.js';

function makeDraft() {
  return {
    title: 'Persist task plan',
    taskGoal: 'Persist task state outside the user repository.',
    scope: ['Add durable workspace plan storage.'],
    constraints: ['Keep review_diff last.'],
    acceptanceCriteria: ['Plan survives process restart.'],
    phases: [
      { type: 'implementation', title: 'Storage', goal: 'Persist the plan.' }
    ]
  };
}

test('workspace plan storage lives under Buildifyx home and not under the workspace repository', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-workspace-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-home-'));
  try {
    const location = await workspacePlanStorageLocation(workspace, { homeDirectory: home });
    assert.equal(location.filePath.startsWith(path.resolve(home)), true);
    assert.equal(location.filePath.startsWith(path.resolve(workspace)), false);
    assert.match(location.filePath, /workspace-state[\\/]+wp1_[a-f0-9]{64}[\\/]+plan\.json$/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('create and load persist a schema-valid plan atomically', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-workspace-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-home-'));
  try {
    const plan = buildWorkspacePlanDocument(makeDraft(), {
      taskId: 'task_storage',
      now: '2026-09-20T07:30:00.000Z'
    });
    await createWorkspacePlanFile(workspace, plan, { homeDirectory: home });

    const loaded = await loadWorkspacePlan(workspace, { homeDirectory: home });
    assert.deepEqual(loaded, plan);

    const location = await workspacePlanStorageLocation(workspace, { homeDirectory: home });
    const onDisk = JSON.parse(await readFile(location.filePath, 'utf8'));
    assert.equal(onDisk.taskId, 'task_storage');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('create refuses to overwrite an existing active task', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-workspace-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-home-'));
  try {
    const plan = buildWorkspacePlanDocument(makeDraft(), {
      taskId: 'task_existing',
      now: '2026-09-20T07:30:00.000Z'
    });
    await createWorkspacePlanFile(workspace, plan, { homeDirectory: home });

    await assert.rejects(
      createWorkspacePlanFile(workspace, plan, { homeDirectory: home }),
      (error) => error?.code === 'PLAN_ALREADY_ACTIVE'
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('concurrent creates serialize so only one task can become active', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-workspace-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-home-'));
  try {
    const first = buildWorkspacePlanDocument(makeDraft(), {
      taskId: 'task_concurrent_a',
      now: '2026-09-20T07:30:00.000Z'
    });
    const second = buildWorkspacePlanDocument(makeDraft(), {
      taskId: 'task_concurrent_b',
      now: '2026-09-20T07:30:01.000Z'
    });

    const results = await Promise.allSettled([
      createWorkspacePlanFile(workspace, first, { homeDirectory: home }),
      createWorkspacePlanFile(workspace, second, { homeDirectory: home })
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected?.reason?.code, 'PLAN_ALREADY_ACTIVE');

    const loaded = await loadWorkspacePlan(workspace, { homeDirectory: home });
    assert.ok(['task_concurrent_a', 'task_concurrent_b'].includes(loaded?.taskId));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('replace requires an existing plan and writes the replacement', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-workspace-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-home-'));
  try {
    const initial = buildWorkspacePlanDocument(makeDraft(), {
      taskId: 'task_replace',
      now: '2026-09-20T07:30:00.000Z'
    });
    const replacement = {
      ...initial,
      revision: 2,
      updatedAt: '2026-09-20T07:31:00.000Z'
    };

    await assert.rejects(
      replaceWorkspacePlanFile(workspace, replacement, { homeDirectory: home }),
      (error) => error?.code === 'PLAN_NOT_FOUND'
    );

    await createWorkspacePlanFile(workspace, initial, { homeDirectory: home });
    await replaceWorkspacePlanFile(workspace, replacement, { homeDirectory: home });
    assert.equal(
      (await loadWorkspacePlan(workspace, { homeDirectory: home }))?.revision,
      2
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('corrupt plan data fails closed with PLAN_INVALID', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-workspace-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-home-'));
  try {
    const location = await workspacePlanStorageLocation(workspace, { homeDirectory: home });
    await mkdir(location.directory, { recursive: true });
    await writeFile(location.filePath, '{not-json', 'utf8');

    await assert.rejects(
      loadWorkspacePlan(workspace, { homeDirectory: home }),
      (error) => error?.code === 'PLAN_INVALID'
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('delete removes the active plan and is idempotent when already absent', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-workspace-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'bdxa-plan-home-'));
  try {
    const plan = buildWorkspacePlanDocument(makeDraft(), {
      taskId: 'task_delete',
      now: '2026-09-20T07:30:00.000Z'
    });
    await createWorkspacePlanFile(workspace, plan, { homeDirectory: home });

    assert.equal(await deleteWorkspacePlanFile(workspace, { homeDirectory: home }), true);
    assert.equal(await loadWorkspacePlan(workspace, { homeDirectory: home }), null);
    assert.equal(await deleteWorkspacePlanFile(workspace, { homeDirectory: home }), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
