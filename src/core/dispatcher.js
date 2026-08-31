import { AgentError, ErrorCode } from './errors.js';
import { assertToolPermission } from './permissions.js';

export function createDispatcher({ services, permissions }) {
  if (!services || typeof services !== 'object') {
    throw new AgentError(ErrorCode.INTERNAL_ERROR, 'services are required');
  }

  return async function dispatch(toolName, input = {}) {
    const handler = services[toolName];
    if (typeof handler !== 'function') {
      throw new AgentError(ErrorCode.TOOL_NOT_FOUND, `Unknown tool: ${toolName}`, { toolName });
    }

    assertToolPermission(toolName, permissions);
    return handler(input);
  };
}
