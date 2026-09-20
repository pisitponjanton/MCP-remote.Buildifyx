import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentError, ErrorCode } from '../core/errors.js';
import { buildifyxHome } from '../utils/home.js';
import { parseWorkspacePlan } from './contract.js';
import { resolveWorkspacePlanIdentity } from './identity.js';

export const WORKSPACE_PLAN_STATE_DIRECTORY = 'workspace-state';
export const WORKSPACE_PLAN_FILE_NAME = 'plan.json';

const WRITE_LOCK_RETRY_MS = 20;
const WRITE_LOCK_TIMEOUT_MS = 5000;
const WRITE_LOCK_STALE_MS = 30_000;

function invalidPlanError(message, details) {
  return new AgentError(ErrorCode.PLAN_INVALID, message, details);
}

async function planLocation(workspacePath, homeDirectory = buildifyxHome()) {
  const identity = await resolveWorkspacePlanIdentity(workspacePath);
  const directory = path.join(homeDirectory, WORKSPACE_PLAN_STATE_DIRECTORY, identity.key);
  return {
    ...identity,
    directory,
    filePath: path.join(directory, WORKSPACE_PLAN_FILE_NAME),
    lockPath: `${directory}.lock`
  };
}

async function acquireWriteLock(location) {
  await mkdir(path.dirname(location.lockPath), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();

  while (true) {
    try {
      await mkdir(location.lockPath, { mode: 0o700 });
      return async () => {
        await rm(location.lockPath, { recursive: true, force: true }).catch(() => undefined);
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;

      try {
        const info = await stat(location.lockPath);
        if (Date.now() - info.mtimeMs > WRITE_LOCK_STALE_MS) {
          await rm(location.lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (lockError) {
        if (lockError?.code === 'ENOENT') continue;
        throw lockError;
      }

      if (Date.now() - startedAt >= WRITE_LOCK_TIMEOUT_MS) {
        throw new AgentError(
          ErrorCode.INTERNAL_ERROR,
          'Timed out waiting for the workspace plan write lock.',
          { workspaceKey: location.key }
        );
      }
      await delay(WRITE_LOCK_RETRY_MS);
    }
  }
}

async function withWriteLock(location, run) {
  const release = await acquireWriteLock(location);
  try {
    return await run();
  } finally {
    await release();
  }
}

async function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function loadWorkspacePlanAtLocation(location) {
  let raw;
  try {
    raw = await readFile(location.filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  let decoded;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw invalidPlanError('Workspace plan file contains invalid JSON.', {
      workspaceKey: location.key,
      filePath: location.filePath,
      cause: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    return parseWorkspacePlan(decoded);
  } catch (error) {
    throw invalidPlanError('Workspace plan file does not match the active plan contract.', {
      workspaceKey: location.key,
      filePath: location.filePath,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

async function deleteAtLocation(location) {
  try {
    await rm(location.filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  await rm(location.directory, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

export async function workspacePlanStorageLocation(workspacePath, options = {}) {
  return planLocation(workspacePath, options.homeDirectory);
}

export async function loadWorkspacePlan(workspacePath, options = {}) {
  const location = await planLocation(workspacePath, options.homeDirectory);
  return loadWorkspacePlanAtLocation(location);
}

export async function createWorkspacePlanFile(workspacePath, plan, options = {}) {
  const parsed = parseWorkspacePlan(plan);
  const location = await planLocation(workspacePath, options.homeDirectory);

  return withWriteLock(location, async () => {
    const existing = await loadWorkspacePlanAtLocation(location);
    if (existing) {
      throw new AgentError(
        ErrorCode.PLAN_ALREADY_ACTIVE,
        'This workspace already has an active task plan.',
        { taskId: existing.taskId, revision: existing.revision }
      );
    }
    await options.beforeCommit?.();
    await atomicWriteJson(location.filePath, parsed);
    return parsed;
  });
}

export async function replaceWorkspacePlanFile(workspacePath, plan, options = {}) {
  const parsed = parseWorkspacePlan(plan);
  const location = await planLocation(workspacePath, options.homeDirectory);

  return withWriteLock(location, async () => {
    const existing = await loadWorkspacePlanAtLocation(location);
    if (!existing) {
      throw new AgentError(
        ErrorCode.PLAN_NOT_FOUND,
        'This workspace does not have an active task plan.'
      );
    }
    await options.beforeCommit?.();
    await atomicWriteJson(location.filePath, parsed);
    return parsed;
  });
}
export async function mutateWorkspacePlanFile(workspacePath, mutate, options = {}) {
  if (typeof mutate !== 'function') throw new TypeError('mutate must be a function.');
  const location = await planLocation(workspacePath, options.homeDirectory);

  return withWriteLock(location, async () => {
    const current = await loadWorkspacePlanAtLocation(location);
    const outcome = await mutate(current);

    if (!outcome || typeof outcome !== 'object') {
      throw new TypeError('Workspace plan mutation must return an outcome object.');
    }

    if (outcome.delete === true) {
      await options.beforeCommit?.();
      await deleteAtLocation(location);
      return outcome.result;
    }

    if ('plan' in outcome) {
      const parsed = parseWorkspacePlan(outcome.plan);
      await options.beforeCommit?.();
      await atomicWriteJson(location.filePath, parsed);
      return outcome.result ?? parsed;
    }

    return outcome.result;
  });
}

export async function deleteWorkspacePlanFile(workspacePath, options = {}) {
  const location = await planLocation(workspacePath, options.homeDirectory);
  return withWriteLock(location, async () => {
    try {
      await stat(location.filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    await options.beforeCommit?.();
    return deleteAtLocation(location);
  });
}