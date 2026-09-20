import { createWorkspacePlanService } from '../workspace-plan/service.js';

export function createWorkspacePlanServices({ root }) {
  const service = createWorkspacePlanService({ root });

  function mutation(handler) {
    return async (input, context = {}) => {
      context.throwIfCancelled?.();
      return handler(input, {
        beforeCommit: () => context.commitSideEffect?.()
      });
    };
  }

  return {
    async get_workspace_plan(_input = {}, context = {}) {
      context.throwIfCancelled?.();
      return { plan: await service.getWorkspacePlan() };
    },
    create_workspace_plan: mutation((input, options) => service.createWorkspacePlan(input, options)),
    update_workspace_plan_intent: mutation((input, options) => service.updateWorkspacePlanIntent(input, options)),
    complete_workspace_phase: mutation((input, options) => service.completeWorkspacePhase(input, options)),
    clear_workspace_plan: mutation((input, options) => service.clearWorkspacePlan(input, options))
  };
}
