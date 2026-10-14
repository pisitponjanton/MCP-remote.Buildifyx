import { createBrowserControlServices } from './browser.js';
import { createImageServices } from '../image/service.js';
import { createCommandService } from './commands.js';
import { createFileServices } from './files.js';
import { createSystemServices } from './system.js';
import { createWorkspacePlanServices } from './workspace-plan.js';

export function createServices({ root, fullAccess = false, namespace = 'cloud', imageCache, cachePrincipalId, browser, getPolicy }) {
  const imageServices = createImageServices({ root, namespace, principalId: cachePrincipalId, getPolicy, ...(imageCache ? { cache: imageCache } : {}) });
  return {
    ...createSystemServices({ root }),
    ...createFileServices({ root }),
    ...createWorkspacePlanServices({ root }),
    ...imageServices,
    ...(browser ? createBrowserControlServices({ ...browser, getPolicy, captureArtifact: imageServices.__storeScreenshot, compareScreenshots: imageServices.__compareScreenshots }) : {}),
    run_command: createCommandService({ root, fullAccess })
  };
}
