import { AgentError, ErrorCode } from './errors.js';

export const PermissionAction = Object.freeze({
  ALLOW: 'allow',
  DENY: 'deny',
  CONFIRM: 'confirm'
});

export const ToolPermission = Object.freeze({
  get_system_info: 'read',
  list_directory: 'read',
  read_file: 'read',
  write_file: 'write',
  edit_file: 'write',
  run_command: 'command'
});

export const DEFAULT_PERMISSION_POLICY = Object.freeze({
  read: PermissionAction.ALLOW,
  write: PermissionAction.ALLOW,
  command: PermissionAction.ALLOW
});

export function createPermissionPolicy(overrides = {}) {
  return {
    ...DEFAULT_PERMISSION_POLICY,
    ...overrides
  };
}

export function assertToolPermission(toolName, policy = DEFAULT_PERMISSION_POLICY) {
  const permission = ToolPermission[toolName];
  if (!permission) {
    throw new AgentError(ErrorCode.TOOL_NOT_FOUND, `Unknown tool: ${toolName}`);
  }

  const action = policy[permission] ?? PermissionAction.DENY;
  if (action === PermissionAction.DENY) {
    throw new AgentError(ErrorCode.PERMISSION_DENIED, `Permission denied for ${toolName} (${permission}).`, {
      toolName,
      permission
    });
  }

  if (action === PermissionAction.CONFIRM) {
    throw new AgentError(ErrorCode.CONFIRMATION_REQUIRED, `Confirmation required for ${toolName} (${permission}).`, {
      toolName,
      permission
    });
  }

  return permission;
}
