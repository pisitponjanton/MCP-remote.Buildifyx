export function getSystemToolDefinitions() {
  return [
    {
      name: 'get_system_info',
      title: 'Get system info',
      description: 'Return basic read-only information about the local machine running the Buildifyx agent.',
      permission: 'read',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    }
  ];
}
