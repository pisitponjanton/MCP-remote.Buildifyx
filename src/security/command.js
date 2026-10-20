import { AgentError, ErrorCode } from '../core/errors.js';

export function validateExecutableName(command) {
  if (typeof command !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.+-]{0,255}$/.test(command)) {
    throw new AgentError(ErrorCode.INVALID_INPUT, 'Command must be an executable name, not a path or shell command string.');
  }
}
