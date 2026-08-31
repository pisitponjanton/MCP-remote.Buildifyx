import { createDispatcher } from './dispatcher.js';
import { createPermissionPolicy } from './permissions.js';
import { createServices } from '../services/index.js';

export function createRuntime({ root, fullAccess = false, permissions = createPermissionPolicy() }) {
  const services = createServices({ root, fullAccess });
  const dispatch = createDispatcher({ services, permissions });

  return {
    root,
    fullAccess,
    permissions,
    services,
    dispatch
  };
}
