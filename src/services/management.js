import path from 'node:path';
import { AgentError, ErrorCode } from '../core/errors.js';
import { isBuildifyxInternalPath } from '../security/path.js';

const POLICY_CATEGORIES = new Set(['read', 'write', 'command', 'dangerous', 'outsideRoot']);
const POLICY_ACTIONS = new Set(['allow', 'ask', 'deny']);

export const MANAGEMENT_ACTIONS = Object.freeze([
  'settings.get',
  'instance.status',
  'permission.set',
  'root.add',
  'root.remove',
  'commandRule.add',
  'commandRule.remove',
  'instance.restart',
  'instance.stop',
  'instance.remove',
  'autostart.get',
  'autostart.set'
]);

function invalid(message) {
  throw new AgentError(ErrorCode.INVALID_INPUT, message);
}

function lifecycleResult(action, callback) {
  if (typeof callback !== 'function') {
    throw new AgentError('MANAGEMENT_UNSUPPORTED', `${action} is not supported by this bdxa instance.`);
  }
  return {
    result: { accepted: true, action },
    afterSend: callback
  };
}

function validateAbsoluteRoot(value) {
  if (typeof value !== 'string' || !value.trim()) invalid('Root path is required.');
  const root = value.trim();
  if (!path.isAbsolute(root)) invalid('Root path must be absolute.');
  if (isBuildifyxInternalPath(root)) invalid('Buildifyx internal state cannot be added as an allowed root.');
  return root;
}

export function createManagementHandler({
  policyManager,
  instance,
  getConnectionState,
  onRestart,
  onStop,
  onRemove,
  getAutostart,
  setAutostart
}) {
  function snapshot() {
    const policy = policyManager.get();
    return {
      instance: {
        instanceId: instance.instanceId,
        name: instance.name,
        workspace: instance.path,
        mode: instance.mode,
        connection: getConnectionState?.() ?? null
      },
      policy
    };
  }

  return async function handleManagement(action, args = {}) {
    if (!MANAGEMENT_ACTIONS.includes(action)) {
      throw new AgentError('MANAGEMENT_ACTION_NOT_FOUND', `Unknown management action: ${action}`);
    }

    if (action === 'settings.get') {
      return {
        ...snapshot(),
        autostart: typeof getAutostart === 'function' ? await getAutostart() : false
      };
    }

    if (action === 'instance.status') {
      return {
        ...snapshot().instance,
        autostart: typeof getAutostart === 'function' ? await getAutostart() : false
      };
    }

    if (action === 'permission.set') {
      if (!POLICY_CATEGORIES.has(args.category) || !POLICY_ACTIONS.has(args.action)) {
        invalid('Invalid permission category or action.');
      }
      return { policy: await policyManager.setCategory(args.category, args.action) };
    }

    if (action === 'root.add') {
      return { policy: await policyManager.addRoot(validateAbsoluteRoot(args.root)) };
    }

    if (action === 'root.remove') {
      return { policy: await policyManager.removeRootByPath(validateAbsoluteRoot(args.root)) };
    }

    if (action === 'commandRule.add') {
      if (typeof args.executable !== 'string' || !args.executable.trim()) invalid('Executable is required.');
      if (!Array.isArray(args.argsPrefix) || !args.argsPrefix.every((value) => typeof value === 'string')) invalid('Invalid command arguments.');
      if (!POLICY_ACTIONS.has(args.action)) invalid('Invalid command rule action.');
      return {
        policy: await policyManager.addCommandRule({
          executable: args.executable.trim(),
          argsPrefix: args.argsPrefix,
          action: args.action
        })
      };
    }

    if (action === 'commandRule.remove') {
      if (typeof args.executable !== 'string' || !args.executable.trim()) invalid('Executable is required.');
      if (!Array.isArray(args.argsPrefix) || !args.argsPrefix.every((value) => typeof value === 'string')) invalid('Invalid command arguments.');
      return {
        policy: await policyManager.removeCommandRuleByMatch({
          executable: args.executable.trim(),
          argsPrefix: args.argsPrefix
        })
      };
    }

    if (action === 'autostart.get') {
      if (typeof getAutostart !== 'function') throw new AgentError('MANAGEMENT_UNSUPPORTED', 'Autostart is not supported by this bdxa instance.');
      return { enabled: await getAutostart() };
    }

    if (action === 'autostart.set') {
      if (typeof args.enabled !== 'boolean') invalid('enabled must be a boolean.');
      if (instance.mode !== 'background') {
        throw new AgentError('BACKGROUND_REQUIRED', 'Autostart can only be enabled for background instances.');
      }
      if (typeof setAutostart !== 'function') throw new AgentError('MANAGEMENT_UNSUPPORTED', 'Autostart is not supported by this bdxa instance.');
      return { enabled: await setAutostart(args.enabled) };
    }

    if (action === 'instance.restart') {
      if (instance.mode !== 'background') throw new AgentError('BACKGROUND_REQUIRED', 'Remote restart is only supported for background instances.');
      return lifecycleResult(action, onRestart);
    }

    if (action === 'instance.stop') return lifecycleResult(action, onStop);
    if (action === 'instance.remove') return lifecycleResult(action, onRemove);

    invalid(`Unsupported management action: ${action}`);
  };
}
