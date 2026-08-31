export const ErrorCode = Object.freeze({
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  PATH_OUTSIDE_ROOT: 'PATH_OUTSIDE_ROOT',
  GIT_INTERNAL_PATH: 'GIT_INTERNAL_PATH',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  FILE_NOT_REGULAR: 'FILE_NOT_REGULAR',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  INVALID_TEXT_FILE: 'INVALID_TEXT_FILE',
  FILE_EXISTS: 'FILE_EXISTS',
  COMMAND_NOT_ALLOWED: 'COMMAND_NOT_ALLOWED',
  COMMAND_TIMEOUT: 'COMMAND_TIMEOUT',
  INVALID_INPUT: 'INVALID_INPUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
});

export class AgentError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function isAgentError(error) {
  return error instanceof AgentError;
}

export function normalizeError(error, fallbackCode = ErrorCode.INTERNAL_ERROR) {
  if (isAgentError(error)) return error;
  return new AgentError(
    fallbackCode,
    error instanceof Error ? error.message : String(error)
  );
}
