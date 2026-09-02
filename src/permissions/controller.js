import { AgentError, ErrorCode } from '../core/errors.js';
import { classifyPath } from '../security/scope.js';
import { describeRequest, evaluateOutsideRoot, evaluateRequest, getRequestedPath, isFullAccessPolicy, matchCommandRule } from './evaluator.js';
import { Decision } from './policy.js';

function resourceOperation(toolName) {
  if (toolName === 'list_directory') return 'list';
  if (toolName === 'read_file') return 'read';
  if (toolName === 'write_file') return 'create';
  if (toolName === 'edit_file') return 'write';
  if (toolName === 'run_command') return 'cwd';
  return null;
}

function permissionDenied(toolName, evaluation) {
  return new AgentError(ErrorCode.PERMISSION_DENIED, `Permission denied: ${evaluation.reason}`, {
    toolName,
    category: evaluation.category
  });
}

export function createPermissionController({ root, policyManager, approvalQueue, eventBus }) {
  return async function authorize(toolName, input, requestId) {
    const policy = policyManager.get();
    let pathInfo = null;
    const requestedPath = getRequestedPath(toolName, input);

    if (requestedPath) {
      pathInfo = await classifyPath({
        root,
        additionalRoots: policy.additionalRoots,
        userPath: requestedPath,
        newFile: toolName === 'write_file'
      });
      eventBus?.emit('resource.access.requested', {
        requestId,
        tool: toolName,
        resourceType: toolName === 'run_command' ? 'directory' : 'file',
        operation: resourceOperation(toolName),
        path: pathInfo.resolved,
        scope: pathInfo.scope
      });
    }

    // Scope and operation permissions are independent gates. An outside-root
    // approval must never implicitly grant write/command/dangerous permission.
    const evaluations = [];
    if (pathInfo?.scope === 'outside') evaluations.push(evaluateOutsideRoot(policy));
    evaluations.push(evaluateRequest({ toolName, input, policy }));

    for (const evaluation of evaluations) {
      eventBus?.emit('permission.evaluated', {
        requestId,
        tool: toolName,
        decision: evaluation.decision,
        category: evaluation.category,
        reason: evaluation.reason
      });
    }

    const denied = evaluations.find((evaluation) => evaluation.decision === Decision.DENY);
    if (denied) throw permissionDenied(toolName, denied);

    let commandApprovedByPrompt = false;
    for (const evaluation of evaluations) {
      if (evaluation.decision !== Decision.ASK) continue;
      if (!approvalQueue) {
        throw new AgentError(ErrorCode.CONFIRMATION_REQUIRED, `Confirmation required: ${describeRequest(toolName, input)}`, {
          toolName,
          category: evaluation.category
        });
      }

      const decision = await approvalQueue.request({
        id: requestId,
        toolName,
        input,
        description: describeRequest(toolName, input),
        category: evaluation.category,
        pathInfo,
        evaluation
      });
      const approved = decision.action === Decision.ALLOW;
      if (!approved) throw permissionDenied(toolName, evaluation);

      if (evaluation.category === 'outsideRoot' && decision.remember === 'root' && pathInfo?.scope === 'outside') {
        await policyManager.addRoot(pathInfo.resolved);
      }
      if (evaluation.category !== 'outsideRoot' && decision.remember === 'command' && toolName === 'run_command') {
        await policyManager.addCommandRule({ executable: input.command, argsPrefix: input.args ?? [], action: Decision.ALLOW });
      }
      if (evaluation.category !== 'outsideRoot' && toolName === 'run_command') commandApprovedByPrompt = true;
    }

    const currentPolicy = policyManager.get();
    const commandRule = toolName === 'run_command' ? matchCommandRule(currentPolicy, input.command, input.args ?? []) : null;
    return {
      pathInfo,
      allowCustomCommand: toolName === 'run_command' && (
        isFullAccessPolicy(currentPolicy)
        || commandApprovedByPrompt
        || commandRule?.action === Decision.ALLOW
      )
    };
  };
}
