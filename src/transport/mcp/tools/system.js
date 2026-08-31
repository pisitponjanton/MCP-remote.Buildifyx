import { errorResult, successResult } from '../response.js';

export function registerSystemTools(server, dispatch) {
  server.registerTool(
    'get_system_info',
    {
      title: 'Get system info',
      description: 'Return basic read-only information about the local machine running the Buildifyx agent.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      try {
        return successResult(await dispatch('get_system_info', {}));
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
