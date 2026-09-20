import { randomUUID } from 'node:crypto';
import { AgentError, ErrorCode } from '../core/errors.js';
import {
  WORKSPACE_PLAN_MAX_PHASES,
  buildFixReviewGoal,
  buildWorkspacePlanDocument,
  workspacePlanClearSchema,
  workspacePlanCompletePhaseSchema,
  workspacePlanIntentUpdateSchema
} from './contract.js';
import {
  createWorkspacePlanFile,
  loadWorkspacePlan,
  mutateWorkspacePlanFile
} from './storage.js';

function notFoundError() {
  return new AgentError(
    ErrorCode.PLAN_NOT_FOUND,
    'This workspace does not have an active task plan.'
  );
}

function revisionConflictError(current, expectedRevision) {
  return new AgentError(
    ErrorCode.PLAN_REVISION_CONFLICT,
    `Workspace plan revision changed from ${expectedRevision} to ${current.revision}.`,
    {
      taskId: current.taskId,
      expectedRevision,
      actualRevision: current.revision
    }
  );
}

function phaseConflictError(current, phaseId) {
  return new AgentError(
    ErrorCode.PLAN_PHASE_CONFLICT,
    `Phase ${phaseId} is not the active phase. Current phase is ${current.currentPhase}.`,
    {
      taskId: current.taskId,
      expectedPhaseId: phaseId,
      currentPhase: current.currentPhase
    }
  );
}

function assertRevision(current, expectedRevision) {
  if (!current) throw notFoundError();
  if (current.revision !== expectedRevision) {
    throw revisionConflictError(current, expectedRevision);
  }
}

function nextRevision(plan, now) {
  return {
    ...plan,
    revision: plan.revision + 1,
    updatedAt: now
  };
}


export function createWorkspacePlanService({
  root,
  homeDirectory,
  now = () => new Date().toISOString(),
  taskId = () => `task_${randomUUID()}`
}) {
  if (typeof root !== 'string' || !root.trim()) {
    throw new TypeError('root is required.');
  }

  const storageOptions = homeDirectory ? { homeDirectory } : {};
  const mutationStorageOptions = (operationOptions = {}) => ({
    ...storageOptions,
    ...(operationOptions.beforeCommit ? { beforeCommit: operationOptions.beforeCommit } : {})
  });

  async function getWorkspacePlan() {
    return loadWorkspacePlan(root, storageOptions);
  }

  async function createWorkspacePlan(input, operationOptions = {}) {
    const createdAt = now();
    const plan = buildWorkspacePlanDocument(input, {
      taskId: taskId(),
      now: createdAt
    });
    return createWorkspacePlanFile(root, plan, mutationStorageOptions(operationOptions));
  }

  async function updateWorkspacePlanIntent(input, operationOptions = {}) {
    const parsed = workspacePlanIntentUpdateSchema.parse(input);

    return mutateWorkspacePlanFile(root, (current) => {
      assertRevision(current, parsed.expectedRevision);
      const {
        expectedRevision: _expectedRevision,
        ...intent
      } = parsed;
      const updated = nextRevision({
        ...current,
        ...intent
      }, now());
      return { plan: updated };
    }, mutationStorageOptions(operationOptions));
  }

  async function completeWorkspacePhase(input, operationOptions = {}) {
    const parsed = workspacePlanCompletePhaseSchema.parse(input);

    return mutateWorkspacePlanFile(root, (current) => {
      assertRevision(current, parsed.expectedRevision);
      if (current.currentPhase !== parsed.phaseId) {
        throw phaseConflictError(current, parsed.phaseId);
      }

      const currentIndex = current.phases.findIndex((phase) => phase.id === current.currentPhase);
      const phase = current.phases[currentIndex];
      if (!phase) throw phaseConflictError(current, parsed.phaseId);

      if (phase.type === 'review_diff') {
        if (!parsed.review) {
          throw new AgentError(
            ErrorCode.PLAN_REVIEW_BLOCKED,
            'Completing review_diff requires an explicit review outcome.',
            { taskId: current.taskId, phaseId: phase.id }
          );
        }

        if (!parsed.review.passed) {
          if (parsed.review.findings.length === 0) {
            throw new AgentError(
              ErrorCode.PLAN_REVIEW_BLOCKED,
              'A failed review_diff must include at least one blocking finding.',
              { taskId: current.taskId, phaseId: phase.id }
            );
          }

          const phases = current.phases.map((candidate) => ({ ...candidate }));
          phases[currentIndex] = { ...phase, status: 'pending' };
          const fixGoal = buildFixReviewGoal(parsed.review.findings);
          const previousIndex = currentIndex - 1;
          const previousFix = previousIndex >= 0 ? phases[previousIndex] : null;
          let fixPhaseId;

          if (previousFix?.type === 'fix_review' && previousFix.status === 'completed') {
            fixPhaseId = previousFix.id;
            phases[previousIndex] = {
              ...previousFix,
              status: 'in_progress',
              goal: fixGoal
            };
          } else {
            if (current.phases.length >= WORKSPACE_PLAN_MAX_PHASES) {
              throw new AgentError(
                ErrorCode.PLAN_INVALID,
                'Workspace plan has no capacity for a required fix_review phase.',
                { taskId: current.taskId, phaseCount: current.phases.length }
              );
            }
            fixPhaseId = Math.max(...current.phases.map((candidate) => candidate.id)) + 1;
            phases.splice(currentIndex, 0, {
              id: fixPhaseId,
              type: 'fix_review',
              title: 'Fix review findings',
              status: 'in_progress',
              goal: fixGoal
            });
          }
          const updated = nextRevision({
            ...current,
            currentPhase: fixPhaseId,
            phases
          }, now());

          return {
            plan: updated,
            result: {
              completed: false,
              reviewPassed: false,
              findings: [...parsed.review.findings],
              plan: updated
            }
          };
        }

        const completedRevision = current.revision + 1;
        return {
          delete: true,
          result: {
            completed: true,
            reviewPassed: true,
            plan: null,
            completedTask: {
              taskId: current.taskId,
              title: current.title,
              revision: completedRevision
            }
          }
        };
      }

      if (parsed.review) {
        throw new AgentError(
          ErrorCode.PLAN_PHASE_CONFLICT,
          'Review outcome is only valid when completing review_diff.',
          { taskId: current.taskId, phaseId: phase.id, phaseType: phase.type }
        );
      }

      const next = current.phases[currentIndex + 1];
      if (!next) {
        throw new AgentError(
          ErrorCode.PLAN_INVALID,
          'Active plan has no phase after the current non-review phase.',
          { taskId: current.taskId, phaseId: phase.id }
        );
      }

      const phases = current.phases.map((candidate, index) => {
        if (index === currentIndex) return { ...candidate, status: 'completed' };
        if (index === currentIndex + 1) return { ...candidate, status: 'in_progress' };
        return { ...candidate };
      });

      const updated = nextRevision({
        ...current,
        currentPhase: next.id,
        phases
      }, now());

      return {
        plan: updated,
        result: {
          completed: false,
          reviewPassed: null,
          plan: updated
        }
      };
    }, mutationStorageOptions(operationOptions));
  }

  async function clearWorkspacePlan(input, operationOptions = {}) {
    const parsed = workspacePlanClearSchema.parse(input);

    return mutateWorkspacePlanFile(root, (current) => {
      assertRevision(current, parsed.expectedRevision);
      return {
        delete: true,
        result: {
          cleared: true,
          plan: null,
          clearedTask: {
            taskId: current.taskId,
            title: current.title,
            revision: current.revision,
            reason: parsed.reason ?? null
          }
        }
      };
    }, mutationStorageOptions(operationOptions));
  }

  return {
    getWorkspacePlan,
    createWorkspacePlan,
    updateWorkspacePlanIntent,
    completeWorkspacePhase,
    clearWorkspacePlan
  };
}
