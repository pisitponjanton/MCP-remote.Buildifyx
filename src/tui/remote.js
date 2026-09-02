import { startTui } from './index.js';
import { requestInstanceControl } from '../utils/instance-control.js';
import { resolveAttachedUpdateStatus } from '../version.js';

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createRemoteDashboardState(instance, initialDashboard, { request = requestInstanceControl, now = Date.now, retryDelayMs = 1000 } = {}) {
  let dashboard = initialDashboard;
  let stopped = false;
  let polling = false;
  let controlDisconnected = false;
  let retryAfter = 0;
  const eventListeners = new Set();
  const approvalListeners = new Set();
  const policyListeners = new Set();

  async function rpc(command, payload = {}, timeoutMs = 1500) {
    const response = await request(instance, command, { timeoutMs, payload });
    if (!response?.ok) throw new Error(response?.error ?? `Instance command failed: ${command}`);
    return response;
  }

  function notifyEvents(previousEvents) {
    if (sameValue(previousEvents, dashboard.events)) return;
    const latest = dashboard.events.at(-1) ?? { type: 'remote.dashboard.refresh' };
    for (const listener of eventListeners) listener(latest);
  }

  function notifyApprovals(previousApprovals) {
    if (sameValue(previousApprovals, dashboard.approvals)) return;
    for (const listener of approvalListeners) listener(dashboard.approvals);
  }

  function notifyPolicy(previousPolicy) {
    if (sameValue(previousPolicy, dashboard.policy)) return;
    for (const listener of policyListeners) listener(dashboard.policy);
  }

  function applyDashboard(next) {
    const previousEvents = dashboard.events;
    const previousApprovals = dashboard.approvals;
    const previousPolicy = dashboard.policy;
    dashboard = next;
    notifyEvents(previousEvents);
    notifyApprovals(previousApprovals);
    notifyPolicy(previousPolicy);
  }

  async function refresh() {
    if (stopped || polling || now() < retryAfter) return;
    polling = true;
    try {
      const response = await rpc('dashboard.snapshot');
      if (!response.dashboard) throw new Error('Instance dashboard snapshot is unavailable.');
      let next = response.dashboard;
      if (controlDisconnected) {
        const timestamp = now();
        next = {
          ...next,
          events: [
            ...(next.events ?? []),
            {
              id: `local-control-connected-${timestamp}`,
              type: 'local.control',
              timestamp: new Date(timestamp).toISOString(),
              status: 'connected',
              cloudStatus: next.connection?.status ?? null
            }
          ]
        };
      }
      controlDisconnected = false;
      retryAfter = 0;
      applyDashboard(next);
    } catch {
      retryAfter = now() + retryDelayMs;
      if (!controlDisconnected) {
        const previousEvents = dashboard.events;
        const timestamp = now();
        dashboard = {
          ...dashboard,
          events: [
            ...(dashboard.events ?? []),
            {
              id: `local-control-disconnected-${timestamp}`,
              type: 'local.control',
              timestamp: new Date(timestamp).toISOString(),
              status: 'disconnected',
              lastError: 'Local instance control channel disconnected.'
            }
          ]
        };
        controlDisconnected = true;
        notifyEvents(previousEvents);
      }
    } finally {
      polling = false;
    }
  }

  async function updatePolicy(command, payload) {
    const response = await rpc(command, payload);
    const previous = dashboard.policy;
    dashboard = { ...dashboard, policy: response.policy };
    notifyPolicy(previous);
    return dashboard.policy;
  }

  const eventBus = {
    getHistory: () => [...dashboard.events],
    subscribe(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    }
  };

  const approvalQueue = {
    getPending: () => [...dashboard.approvals],
    subscribe(listener) {
      approvalListeners.add(listener);
      return () => approvalListeners.delete(listener);
    },
    resolve(approvalId, decision) {
      void rpc('approval.resolve', {
        approvalId,
        requestId: approvalId,
        action: decision.action,
        remember: decision.remember ?? null
      }).then(() => refresh()).catch(() => refresh());
      return true;
    }
  };

  const policyManager = {
    get: () => dashboard.policy,
    subscribe(listener) {
      policyListeners.add(listener);
      return () => policyListeners.delete(listener);
    },
    setCategory(category, action) {
      return updatePolicy('policy.setCategory', { category, action });
    },
    addRoot(root) {
      return updatePolicy('policy.addRoot', { root });
    },
    removeRoot(index) {
      return updatePolicy('policy.removeRoot', { index });
    },
    addCommandRule(rule) {
      return updatePolicy('policy.addCommandRule', {
        executable: rule.executable,
        argsPrefix: Array.isArray(rule.argsPrefix) ? rule.argsPrefix : [],
        action: rule.action ?? 'ask'
      });
    },
    removeCommandRule(index) {
      return updatePolicy('policy.removeCommandRule', { index });
    }
  };

  return {
    get dashboard() { return dashboard; },
    eventBus,
    approvalQueue,
    policyManager,
    refresh,
    stop() { stopped = true; },
    get stopped() { return stopped; }
  };
}

export async function runAttachedDashboard(instance, { metadata = null, updateStatus = null } = {}) {
  const response = await requestInstanceControl(instance, 'dashboard.snapshot', { timeoutMs: 1500 });
  if (!response?.ok || !response.dashboard) throw new Error('Could not load the workspace dashboard.');

  const remote = createRemoteDashboardState(instance, response.dashboard);
  const interval = setInterval(() => { void remote.refresh(); }, 300);
  const dashboard = remote.dashboard;
  const runningVersion = dashboard.version ?? metadata?.version;
  const attachedUpdateStatus = resolveAttachedUpdateStatus({
    runningVersion,
    installedVersion: metadata?.version ?? runningVersion,
    updateStatus: updateStatus ?? dashboard.updateStatus
  });

  const tui = startTui({
    eventBus: remote.eventBus,
    approvalQueue: remote.approvalQueue,
    policyManager: remote.policyManager,
    version: runningVersion,
    updateStatus: attachedUpdateStatus,
    root: dashboard.root,
    instanceId: dashboard.instanceId,
    instanceName: dashboard.instanceName,
    mode: dashboard.accessMode,
    auditPath: dashboard.auditPath,
    toolManifest: dashboard.toolManifest,
    toolManifestState: dashboard.toolManifestState,
    toolsUrl: dashboard.toolsUrl,
    attached: true,
    onQuit: async () => {
      remote.stop();
      clearInterval(interval);
    }
  });

  try {
    await tui.waitUntilExit();
  } finally {
    remote.stop();
    clearInterval(interval);
  }
}
