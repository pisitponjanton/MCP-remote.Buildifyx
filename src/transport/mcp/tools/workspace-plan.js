import {
  workspacePlanClearSchema,
  workspacePlanCompletePhaseSchema,
  workspacePlanDraftSchema,
  workspacePlanIntentUpdateSchema
} from '../../../workspace-plan/contract.js';

export function getWorkspacePlanToolDefinitions() {
  return [
    {
      name: 'get_workspace_plan',
      title: 'Get workspace task plan',
      description: 'Read the active task plan for this workspace. Returns the authoritative task goal, scope, constraints, acceptance criteria, revision, and current phase so a task can resume safely across chats.',
      permission: 'read',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    {
      name: 'create_workspace_plan',
      title: 'Create workspace task plan',
      description: 'Create the single active task plan for this workspace. If review_diff is omitted it is added automatically as the final phase. Creation fails while another active task exists.',
      permission: 'write',
      inputSchema: workspacePlanDraftSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    {
      name: 'update_workspace_plan_intent',
      title: 'Update workspace task intent',
      description: 'Explicitly update authoritative task intent fields using expectedRevision. Use only when the task direction actually changes; stale revisions are rejected.',
      permission: 'write',
      inputSchema: workspacePlanIntentUpdateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    {
      name: 'complete_workspace_phase',
      title: 'Complete workspace task phase',
      description: 'Complete the current phase using expectedRevision. Failed review_diff creates a fix_review phase; successful final review_diff removes the active plan.',
      permission: 'write',
      inputSchema: workspacePlanCompletePhaseSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    {
      name: 'clear_workspace_plan',
      title: 'Clear workspace task plan',
      description: 'Explicitly abandon or reset the active task plan using expectedRevision. Normal successful completion should happen through review_diff instead.',
      permission: 'write',
      inputSchema: workspacePlanClearSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    }
  ];
}
