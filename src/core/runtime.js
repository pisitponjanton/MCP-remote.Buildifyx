import { createDispatcher } from './dispatcher.js';
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

export function createRuntime({
  root,
  fullAccess = false,
  permissions,
  policy = legacyPermissionsToPolicy(permissions),
  policyManager = createPolicyManager(normalizePolicy(policy)),
  eventBus = createEventBus(),
  approvalQueue,
  interactive = !permissions
}) {
  const activeApprovalQueue = interactive ? (approvalQueue ?? createApprovalQueue({ eventBus })) : null;
  const services = createServices({ root, fullAccess });
  const authorize = createPermissionController({ root, policyManager, approvalQueue: activeApprovalQueue, eventBus });
  const dispatch = createDispatcher({ services, authorize, eventBus });

  return {
    root,
    fullAccess,
    policyManager,
    eventBus,
    approvalQueue: activeApprovalQueue,
    services,
    dispatch
  };
}
