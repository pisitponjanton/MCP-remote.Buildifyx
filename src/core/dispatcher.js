import { randomUUID } from 'node:crypto';
import { AgentError, ErrorCode, normalizeError } from './errors.js';

function summarizeInput(toolName, input = {}) {
  const summary = { ...input };
  if (typeof summary.content === 'string') summary.content = `<${summary.content.length} chars>`;
  if (Array.isArray(summary.lines)) summary.lines = `<${summary.lines.length} lines>`;
  return summary;
}

export function createDispatcher({ services, authorize, eventBus }) {
  if (!services || typeof services !== 'object') {
    throw new AgentError(ErrorCode.INTERNAL_ERROR, 'services are required');
  }

  return async function dispatch(toolName, input = {}, options = {}) {
    const requestId = options.requestId ?? randomUUID();
    const startedAt = Date.now();
    const handler = services[toolName];

    eventBus?.emit('tool.started', {
      requestId,
      tool: toolName,
      input: summarizeInput(toolName, input)
    });

    if (typeof handler !== 'function') {
      const error = new AgentError(ErrorCode.TOOL_NOT_FOUND, `Unknown tool: ${toolName}`, { toolName });
      eventBus?.emit('tool.failed', { requestId, tool: toolName, durationMs: Date.now() - startedAt, error: { code: error.code, message: error.message } });
      throw error;
    }

    try {
      const context = authorize ? await authorize(toolName, input, requestId) : {};
      const result = await handler(input, { ...context, requestId, eventBus });
      eventBus?.emit('tool.completed', { requestId, tool: toolName, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      const normalized = normalizeError(error);
      eventBus?.emit('tool.failed', {
        requestId,
        tool: toolName,
        durationMs: Date.now() - startedAt,
        error: { code: normalized.code, message: normalized.message }
      });
      throw normalized;
    }
  };
}
