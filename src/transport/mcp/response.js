import { normalizeError } from '../../core/errors.js';

export function successResult(structuredContent, { isError } = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    ...(isError ? { isError: true } : {})
  };
}

export function errorResult(error) {
  const normalized = normalizeError(error);
  const structuredContent = {
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details !== undefined ? { details: normalized.details } : {})
    }
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    isError: true
  };
}
