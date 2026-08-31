import { createCommandService } from './commands.js';
import { createFileServices } from './files.js';
import { createSystemServices } from './system.js';

export function createServices({ root, fullAccess = false }) {
  return {
    ...createSystemServices({ root }),
    ...createFileServices({ root }),
    run_command: createCommandService({ root, fullAccess })
  };
}
