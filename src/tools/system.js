import os from 'node:os';
import process from 'node:process';

export function registerSystemTools(server, { root }) {
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
      const result = {
        platform: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
        osRelease: os.release(),
        nodeVersion: process.version,
        allowedRoot: root
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result
      };
    }
  );
}
