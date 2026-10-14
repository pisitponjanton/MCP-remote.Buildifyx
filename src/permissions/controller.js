import { AgentError, ErrorCode } from '../core/errors.js';
import { classifyPath } from '../security/scope.js';
import { validateBrowserUrl } from '../browser/session-engine.js';
import { describeRequest, evaluateOutsideRoot, evaluateRequest, getRequestedPaths, isFullAccessPolicy, matchCommandRule } from './evaluator.js';
import { Decision } from './policy.js';

function resourceOperation(toolName) {
  if (toolName === 'list_directory') return 'list';
  if (toolName === 'read_file') return 'read';
  if (toolName === 'write_file') return 'create';
  if (toolName === 'edit_file') return 'write';
  if (toolName === 'run_command') return 'cwd';
  if (['read_image', 'get_image_info', 'resize_image', 'save_image', 'get_cached_image'].includes(toolName)) return 'read';
  if (toolName === 'save_cached_image') return 'create';
  return null;
}

function permissionDenied(toolName, evaluation) {
  return new AgentError(ErrorCode.PERMISSION_DENIED, `Permission denied: ${evaluation.reason}`, {
    toolName,
    category: evaluation.category
  });
}

export function createPermissionController({ root, policyManager, approvalQueue, eventBus, artifactRequiresCapture }) {
  return async function authorize(toolName, input, requestId) {
    if (toolName === 'browser_open' && input.kind === 'persistent' && input.confirmPersistent !== true) {
      throw new AgentError('BROWSER_CONSENT_REQUIRED', 'Persistent profile requires confirmPersistent: true.');
    }
    if ((toolName === 'browser_open' || toolName === 'browser_navigate') && typeof input.url === 'string') {
      validateBrowserUrl(input.url);
    }
    const policy = policyManager.get();
    let pathInfo = null;
    const pathInfos = {};
    for (const requested of getRequestedPaths(toolName, input)) {
      const info = await classifyPath({
        root, additionalRoots: policy.additionalRoots,
        userPath: requested.value, newFile: requested.newFile
      });
      pathInfos[requested.key] = info;
      if (!pathInfo) pathInfo = info;
      eventBus?.emit('resource.access.requested', {
        requestId, tool: toolName,
        resourceType: toolName === 'run_command' ? 'directory' : 'file',
        operation: requested.newFile ? 'create' : resourceOperation(toolName),
        path: info.resolved, scope: info.scope
      });
    }

    const evaluations = Object.values(pathInfos)
      .filter((info) => info.scope === 'outside')
      .map((info) => ({ ...evaluateOutsideRoot(policy), pathInfo: info }));
    // save_image copies bytes from an existing source: imageSave alone must
    // never authorize the read. Keep both categories in the same request so
    // Ask/Allow/Deny and later policy revocation are independently enforced.
    if (toolName === 'save_image') {
      evaluations.push({ category: 'imageRead', decision: policy.categories.imageRead ?? Decision.DENY,
        reason: 'Reading the source image requires imageRead permission' });
    }
    evaluations.push(evaluateRequest({ toolName, input, policy }));
    const cachedImageTools = new Set(['get_cached_image', 'get_image_info', 'resize_image', 'save_cached_image']);
    if (cachedImageTools.has(toolName) && input.artifactId && typeof artifactRequiresCapture === 'function'
      && await artifactRequiresCapture(input.artifactId)) {
      evaluations.push({ category: 'browserCapture',
        decision: policy.categories.browserCapture ?? Decision.ASK,
        reason: 'Screenshot or screenshot-derived artifact requires additional capture approval' });
    }
    if (toolName === 'browser_open' && input.kind === 'persistent') {
      evaluations.push({ category: 'persistentProfile', decision: policy.categories.persistentProfile ?? Decision.DENY,
        reason: 'Persistent browser profile requires separate approval' });
    }

    if ((toolName === 'browser_open' || toolName === 'browser_navigate') && typeof input.url === 'string') {
      const host = (() => { try { return new URL(input.url).hostname.toLowerCase(); } catch { return ''; } })();
      if (host && host !== 'localhost' && !host.endsWith('.localhost') && host !== '::1' && !/^127(?:\.\d{1,3}){3}$/.test(host)) {
        evaluations.push({ category: 'browserExternal', decision: policy.categories.browserExternal ?? Decision.ASK,
          reason: 'External browser origin requires separate approval' });
      }
    }
    if ((toolName === 'browser_click' || toolName === 'browser_fill') && input.confirmSensitive === true) {
      evaluations.push({ category: 'browserSensitive', decision: policy.categories.browserSensitive ?? Decision.ASK,
        reason: 'Explicit per-action confirmation for potentially sensitive browser interaction' });
    }

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
        requestId,
        toolName,
        input: String(toolName).startsWith('browser_') ? { ...input,
          ...(input.value !== undefined ? { value: '<redacted>' } : {}),
          ...(input.url !== undefined ? { url: '[redacted external URL]' } : {}),
          ...(input.target !== undefined ? { target: '[redacted target]' } : {}) } : input,
        description: describeRequest(toolName, input),
        category: evaluation.category,
        pathInfo: evaluation.pathInfo ?? pathInfo,
        evaluation
      });
      const approved = decision.action === Decision.ALLOW;
      if (!approved) throw permissionDenied(toolName, evaluation);

      if (evaluation.category === 'outsideRoot' && decision.remember === 'root' && evaluation.pathInfo?.scope === 'outside') {
        await policyManager.addRoot(evaluation.pathInfo.resolved);
      }
      if (evaluation.category !== 'outsideRoot' && decision.remember === 'command' && toolName === 'run_command') {
        await policyManager.addCommandRule({ executable: input.command, argsPrefix: input.args ?? [], action: Decision.ALLOW });
      }
      if (evaluation.category !== 'outsideRoot' && toolName === 'run_command') commandApprovedByPrompt = true;
    }

    const currentPolicy = policyManager.get();
    const commandRule = toolName === 'run_command' ? matchCommandRule(currentPolicy, input.command, input.args ?? []) : null;
    return {
      assertStillAllowed() {
        const latest = policyManager.get();
        for (const evaluation of evaluations) {
          if (evaluation.category === 'outsideRoot' || evaluation.category === 'commandRule') continue;
          const current = latest.categories[evaluation.category] ?? Decision.DENY;
          if (current === Decision.DENY || (evaluation.decision === Decision.ALLOW && current !== Decision.ALLOW)) {
            throw permissionDenied(toolName, { ...evaluation, reason: 'Permission changed during the request' });
          }
        }
      },
      screenshotApproved: evaluations.some(x => x.category === 'browserCapture'),
      sensitiveApproved: input.confirmSensitive === true && evaluations.some(x => x.category === 'browserSensitive'),
      pathInfo,
      sourcePathInfo: pathInfos.sourcePath,
      destinationPathInfo: pathInfos.destinationPath,
      persistentApproved: toolName === 'browser_open' && input.kind === 'persistent'
        && evaluations.some(item => item.category === 'persistentProfile')
        && evaluations.every(item => item.decision !== Decision.DENY),
      allowCustomCommand: toolName === 'run_command' && (
        isFullAccessPolicy(currentPolicy)
        || commandApprovedByPrompt
        || commandRule?.action === Decision.ALLOW
      )
    };
  };
}
