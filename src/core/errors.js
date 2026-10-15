export const ErrorCode = Object.freeze({
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',
  REQUEST_CANCELLED: 'REQUEST_CANCELLED',
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
  PLAN_INVALID: 'PLAN_INVALID',
  PLAN_ALREADY_ACTIVE: 'PLAN_ALREADY_ACTIVE',
  PLAN_NOT_FOUND: 'PLAN_NOT_FOUND',
  PLAN_REVISION_CONFLICT: 'PLAN_REVISION_CONFLICT',
  PLAN_PHASE_CONFLICT: 'PLAN_PHASE_CONFLICT',
  PLAN_REVIEW_BLOCKED: 'PLAN_REVIEW_BLOCKED',
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


// Keep known structured tool error codes even when legacy Image/Cache/Browser
// helpers throw Error objects rather than AgentError. Never let a Node/OS
// failure or an unknown caller-supplied code escape as a trusted tool error.
const TOOL_ERROR_CODES = new Set([
  ...Object.values(ErrorCode),
  'UNSUPPORTED_CAPABILITY', 'BROWSER_CAPTURE_DENIED',
  'BROWSER_CONSENT_REQUIRED', 'MEDIA_IMPORT_PERMISSION_REQUIRED',
  'MEDIA_IMPORT_BUSY', 'INSTANCE_CONTROL_TIMEOUT', 'INSTANCE_CONTROL_ABORTED'
]);
const domainCode = /^(?:CACHE|BROWSER|IMAGE|MEDIA)_[A-Z][A-Z0-9_]{0,63}$/;

export function normalizeToolError(error) {
  if (isAgentError(error)) return error;
  const code = error?.code;
  if (typeof code === 'string' && (TOOL_ERROR_CODES.has(code) || domainCode.test(code))) {
    const message = typeof error?.message === 'string' ? error.message : 'Tool failed.';
    return new AgentError(code, message);
  }
  // Preserve internal diagnostics for trusted local callers and existing
  // policies, but never expose this raw message through Cloud/MCP or audit.
  return new AgentError(ErrorCode.INTERNAL_ERROR,
    error instanceof Error ? error.message : String(error));
}

// Public tool results must not contain arbitrary paths, URLs, tokens, browser
// form values, stack traces or details supplied by a failed dependency.
// Return actionable stable codes; local event logs can retain internal context.
export function publicToolError(error) {
  const normalized = normalizeToolError(error);
  const rawCode = normalized.code;
  const code = typeof rawCode === 'string' && (TOOL_ERROR_CODES.has(rawCode) || domainCode.test(rawCode))
    ? rawCode : ErrorCode.INTERNAL_ERROR;
  const message = code === ErrorCode.PERMISSION_DENIED
    ? 'Permission denied by local policy or by the user.'
    : code === ErrorCode.CONFIRMATION_REQUIRED
      ? 'Local approval is required for this tool.'
      : code === ErrorCode.REQUEST_CANCELLED || code === 'INSTANCE_CONTROL_ABORTED'
        ? 'Tool request was cancelled or timed out before completion.'
        : code === 'MEDIA_TIMEOUT' || code === 'INSTANCE_CONTROL_TIMEOUT'
          ? 'Tool transport or media request timed out.'
          : code === ErrorCode.INTERNAL_ERROR
            ? 'Tool failed unexpectedly. Check local diagnostics.'
            : code === ErrorCode.INVALID_INPUT
              ? 'Invalid tool input.'
              : code === ErrorCode.TOOL_NOT_FOUND
                ? 'Unknown tool.'
                : code === 'IMAGE_EXISTS'
                  ? 'Destination file already exists. Choose a new filename; images are never overwritten.'
                  : code === 'IMAGE_PATH_DENIED'
                    ? 'Image path is not authorized. Choose a location inside an approved workspace root.'
                    : code === 'IMAGE_PATH_CHANGED'
                      ? 'Image destination path changed during validation. Check the folder and try again.'
                      : code === 'MEDIA_IMPORT_PERMISSION_REQUIRED'
                        ? 'Image import requires local imageRead and cacheManage permissions set to Allow.'
                        : code === 'CACHE_NOT_FOUND'
                          ? 'Temporary image was not found or has expired. Import the image again.'
                          : domainCode.test(code)
                            ? `Tool failed with ${code}.`
                            : `Tool failed with ${code}.`;
  const details = normalized.details;
  const safeDetails = {};
  if ([ErrorCode.PERMISSION_DENIED, ErrorCode.CONFIRMATION_REQUIRED].includes(code) && details) {
    if (typeof details.category === 'string' && /^[a-zA-Z]{1,40}$/.test(details.category)) safeDetails.category = details.category;
    if (typeof details.toolName === 'string' && /^[a-z_]{1,80}$/.test(details.toolName)) safeDetails.toolName = details.toolName;
  }
  return { code, message, ...(Object.keys(safeDetails).length ? { details: safeDetails } : {}) };
}
