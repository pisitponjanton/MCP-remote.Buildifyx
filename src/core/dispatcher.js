import { randomUUID } from 'node:crypto';
import { AgentError, ErrorCode, normalizeError } from './errors.js';

function compactText(value, maxLength = 160) {
  if (typeof value !== 'string' || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…<${value.length - maxLength} more chars>`;
}

function summarizeInput(toolName, input = {}) {
  const summary = { ...input };
  if (typeof summary.content === 'string') summary.content = `<${summary.content.length} chars>`;
  if (Array.isArray(summary.lines)) summary.lines = `<${summary.lines.length} lines>`;
  if (Array.isArray(summary.args)) {
    const shown = summary.args.slice(0, 12).map((arg) => compactText(arg));
    if (summary.args.length > shown.length) shown.push(`<${summary.args.length - shown.length} more args>`);
    summary.args = shown;
  }
  if (typeof summary.command === 'string') summary.command = compactText(summary.command, 256);
  if (typeof summary.cwd === 'string') summary.cwd = compactText(summary.cwd, 512);
  if (typeof summary.path === 'string') summary.path = compactText(summary.path, 512);
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
