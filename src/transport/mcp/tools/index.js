import { registerCommandTools } from './commands.js';
import { registerFileTools } from './files.js';
import { registerSystemTools } from './system.js';

export function registerMcpTools(server, dispatch, options = {}) {
  registerSystemTools(server, dispatch);
  registerFileTools(server, dispatch);
  registerCommandTools(server, dispatch, options);
}
