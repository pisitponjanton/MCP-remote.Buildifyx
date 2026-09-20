import { createCommandService } from './commands.js';
import { createFileServices } from './files.js';
import { createSystemServices } from './system.js';
import { createWorkspacePlanServices } from './workspace-plan.js';

export function createServices({ root, fullAccess = false }) {
  return {
    ...createSystemServices({ root }),
    ...createFileServices({ root }),
    ...createWorkspacePlanServices({ root }),
    run_command: createCommandService({ root, fullAccess })
  };
}