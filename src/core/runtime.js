import { AgentError, ErrorCode } from './errors.js';
import { createDispatcher } from './dispatcher.js';
import { createBrowserSessionEngine } from '../browser/session-engine.js';
import { createServices } from '../services/index.js';
import { createEventBus } from '../events/bus.js';
import { createApprovalQueue } from '../permissions/approvals.js';
import { createPermissionController } from '../permissions/controller.js';
import { createPolicyManager } from '../permissions/manager.js';
import { normalizePolicy } from '../permissions/policy.js';

function legacyPermissionsToPolicy(permissions) {
  if (!permissions) return undefined;
  const map = (value) => value === 'confirm' ? 'ask' : value;
  return {
    categories: {
      read: map(permissions.read),
      write: map(permissions.write),
      command: map(permissions.command)
    }
  };
}

function createRequestLifecycle() {
  const active = new Map();
  const cancelled = new Map();
  const recent = new Map();
  const idleWaiters = new Set();
  let acceptingRequests = true;

  function trim(map, limit = 500) {
    while (map.size > limit) map.delete(map.keys().next().value);
  }

  function rememberCancellation(requestId, error) {
    if (!requestId) return;
    cancelled.set(requestId, error);
    trim(cancelled);
  }

  function rememberRecent(requestId, outcome) {
    if (!requestId) return;
    recent.set(requestId, outcome);
    trim(recent);
  }

  function duplicateRequestError(requestId, state) {
    return new AgentError(ErrorCode.INVALID_INPUT, `Request ID has already been used: ${requestId}`, {
      requestId,
      state
    });
  }

  function stoppingError(requestId) {
    return new AgentError(ErrorCode.REQUEST_CANCELLED, 'Agent is shutting down and is not accepting new requests.', { requestId });
  }

  function throwCancellation(requestId, signal, committed = false) {
    if (committed) return;
    const error = cancelled.get(requestId) ?? signal?.reason;
    if (error) throw error;
  }

  return {
    begin(requestId) {
      if (!acceptingRequests) throw stoppingError(requestId);
      if (active.has(requestId)) throw duplicateRequestError(requestId, 'active');
      if (recent.has(requestId)) throw duplicateRequestError(requestId, 'completed');
      const existingCancellation = cancelled.get(requestId);
      if (existingCancellation) throw existingCancellation;

      const controller = new AbortController();
      let committed = false;
      const context = {
        signal: controller.signal,
        throwIfCancelled: () => throwCancellation(requestId, controller.signal, committed),
        commitSideEffect() {
          throwCancellation(requestId, controller.signal, committed);
          committed = true;
        },
        get sideEffectCommitted() { return committed; }
      };
      active.set(requestId, { controller, context });
      return context;
    },
    end(requestId, context, outcome = 'completed') {
      if (!context) return;
      const current = active.get(requestId);
      if (!current || current.context !== context) return;
      active.delete(requestId);
      rememberRecent(requestId, outcome);
      if (active.size === 0) {
        for (const resolve of idleWaiters) resolve(true);
        idleWaiters.clear();
      }
    },
    cancel(requestId, error) {
      if (recent.has(requestId)) return false;
      const current = active.get(requestId);
      if (current?.context.sideEffectCommitted) return false;
      rememberCancellation(requestId, error);
      if (current && !current.controller.signal.aborted) current.controller.abort(error);
      return true;
    },
    stop(error) {
      acceptingRequests = false;
      for (const [requestId, current] of active.entries()) {
        if (current.context.sideEffectCommitted) continue;
        rememberCancellation(requestId, error);
        if (!current.controller.signal.aborted) current.controller.abort(error);
      }
      return active.size > 0;
    },
    waitForIdle(timeoutMs = 2000) {
      if (active.size === 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          idleWaiters.delete(finish);
          resolve(value);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref?.();
        idleWaiters.add(finish);
      });
    },
    get acceptingRequests() { return acceptingRequests; }
  };
}

export function createRuntime({
  root,
  fullAccess = false,
  namespace = 'cloud',
  imageCache,
  instanceId,
  principalId,
  cachePrincipalId = principalId,
  browserStoragePrincipalId = principalId,
  legacyBrowserStoragePrincipalId = null,
  browserOptions = {},
  permissions,
  policy = legacyPermissionsToPolicy(permissions),
  policyManager = createPolicyManager(normalizePolicy(policy)),
  eventBus = createEventBus(),
  approvalQueue,
  interactive = !permissions
}) {
  const activeApprovalQueue = interactive ? (approvalQueue ?? createApprovalQueue({ eventBus })) : null;
  const browserEngines = new Set();
  const makeBrowserEngine = ({ instanceId: ownerInstance, principalId: ownerPrincipal, ...options }) => {
    const engine = createBrowserSessionEngine({ ...browserOptions, ...options,
      workspaceRoot: root, namespace, instanceId: ownerInstance, principalId: ownerPrincipal,
      storagePrincipalId: browserStoragePrincipalId, legacyStoragePrincipalId: legacyBrowserStoragePrincipalId });
    browserEngines.add(engine);
    return engine;
  };
  const services = createServices({ root, fullAccess, namespace, imageCache, cachePrincipalId, getPolicy: () => policyManager.get(),
    browser: instanceId && principalId ? { instanceId, principalId, createEngine: makeBrowserEngine } : undefined });
  let previousCategories = { ...policyManager.get().categories };
  const unsubscribeBrowserPolicy = policyManager.subscribe(next => {
    const current = next.categories;
    const restricted = ['browserNavigate', 'browserRead', 'browserExternal']
      .some(key => previousCategories[key] !== 'deny' && current[key] === 'deny');
    const persistentRestricted = previousCategories.persistentProfile !== 'deny' && current.persistentProfile === 'deny';
    const imageImportRestricted = ['imageRead', 'cacheManage'].some(key =>
      previousCategories[key] === 'allow' && current[key] !== 'allow');
    previousCategories = { ...current };
    if (imageImportRestricted) services.__clearCloudImports?.();
    if (restricted) void services.closeActive?.().catch(() => undefined);
    else if (persistentRestricted) void services.closeActive?.({ persistentOnly: true }).catch(() => undefined);
  });
  const authorize = createPermissionController({ root, policyManager, approvalQueue: activeApprovalQueue, eventBus,
    artifactRequiresCapture: services.__artifactRequiresCapture, unrestrictedCommands: fullAccess });
  const requestLifecycle = createRequestLifecycle();
  const dispatch = createDispatcher({ services, authorize, eventBus, requestLifecycle });
  const cancellationError = (reason) => new AgentError(ErrorCode.REQUEST_CANCELLED, reason);

  return {
    root,
    fullAccess,
    policyManager,
    eventBus,
    approvalQueue: activeApprovalQueue,
    services,
    dispatch,
    createBrowserEngine({ instanceId, principalId, ...options } = {}) {
      if (!requestLifecycle.acceptingRequests) throw cancellationError('Agent is shutting down');
      return makeBrowserEngine({ instanceId, principalId, ...options });
    },
    cancel(requestId, reason = 'Cloud request was cancelled') {
      const error = cancellationError(reason);
      const requestCancelled = requestLifecycle.cancel(requestId, error);
      if (!requestCancelled) return false;
      activeApprovalQueue?.cancel(requestId, error);
      services.run_command?.cancel?.(requestId, error);
      return true;
    },
    async stop(reason = 'Agent is shutting down', { force = false } = {}) {
      const error = cancellationError(reason);
      requestLifecycle.stop(error);
      unsubscribeBrowserPolicy();
      activeApprovalQueue?.cancelAll?.(error);
      await services.run_command?.stopAll?.(error, { force });
      await requestLifecycle.waitForIdle(force ? 500 : 2000);
      services.closeImageCache?.();
      await services.closeBrowserControls?.();
      const failures = [];
      for (const engine of browserEngines) {
        try { await engine.closeAll(); } catch (error) { failures.push(error); }
      }
      browserEngines.clear();
      if (failures.length) throw failures[0];
    },
    get acceptingRequests() { return requestLifecycle.acceptingRequests; }
  };
}
