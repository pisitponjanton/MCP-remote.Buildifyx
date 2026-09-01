import { AgentError, ErrorCode } from '../core/errors.js';
import { classifyPath } from '../security/scope.js';
import { describeRequest, evaluateRequest, getRequestedPath, isFullAccessPolicy, matchCommandRule } from './evaluator.js';
import { Decision } from './policy.js';

function resourceOperation(toolName) {
  if (toolName === 'list_directory') return 'list';
  if (toolName === 'read_file') return 'read';
  if (toolName === 'write_file') return 'create';
  if (toolName === 'edit_file') return 'write';
  if (toolName === 'run_command') return 'cwd';
  return null;
}

export function createPermissionController({ root, policyManager, approvalQueue, eventBus }) {
  return async function authorize(toolName, input, requestId) {
    const policy = policyManager.get();
    let pathInfo = null;
    let approvedByPrompt = false;
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

    const evaluation = evaluateRequest({
      toolName,
      input,
      policy,
      pathScope: pathInfo?.scope === 'outside' ? 'outside' : 'root'
    });

    eventBus?.emit('permission.evaluated', {
      requestId,
      tool: toolName,
      decision: evaluation.decision,
      category: evaluation.category,
      reason: evaluation.reason
    });

    let approved = evaluation.decision === Decision.ALLOW;
    if (evaluation.decision === Decision.ASK) {
      if (!approvalQueue) {
        throw new AgentError(ErrorCode.CONFIRMATION_REQUIRED, `Confirmation required: ${describeRequest(toolName, input)}`);
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
      approved = decision.action === 'allow';
      approvedByPrompt = approved;
      if (approved && decision.remember === 'command' && toolName === 'run_command') {
        await policyManager.addCommandRule({ executable: input.command, argsPrefix: input.args ?? [], action: 'allow' });
      }
      if (approved && decision.remember === 'root' && pathInfo?.scope === 'outside') {
        await policyManager.addRoot(pathInfo.resolved);
      }
    }

    if (!approved || evaluation.decision === Decision.DENY) {
      throw new AgentError(ErrorCode.PERMISSION_DENIED, `Permission denied: ${describeRequest(toolName, input)}`, {
        toolName,
        category: evaluation.category
      });
    }

    const currentPolicy = policyManager.get();
    return {
      pathInfo,
      allowCustomCommand: toolName === 'run_command' && (
        isFullAccessPolicy(currentPolicy) || approvedByPrompt || Boolean(matchCommandRule(currentPolicy, input.command, input.args ?? []))
      )
    };
  };
}
