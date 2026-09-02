export function shortTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

export function summarizeInput(input = {}) {
  if (input.command) return `${input.command} ${(input.args ?? []).join(' ')}`.trim();
  if (input.path) return input.path;
  return '';
}

export function groupActivities(events) {
  const groups = new Map();

  for (const event of events) {
    if (!event.requestId) continue;
    if (!groups.has(event.requestId)) groups.set(event.requestId, []);
    groups.get(event.requestId).push(event);
  }

  return [...groups.entries()]
    .map(([requestId, items]) => {
      const startedEvent = items.find((event) => event.type === 'tool.started');
      const toolEvent = startedEvent ?? items.find((event) => typeof event.tool === 'string' && event.tool);
      if (!toolEvent) return null;
      const started = startedEvent ?? { ...toolEvent, type: 'tool.started', input: {} };
      const completed = items.find((event) => event.type === 'tool.completed');
      const failed = items.find((event) => event.type === 'tool.failed');
      const permissions = items.filter((event) => event.type === 'permission.evaluated');
      const permission = permissions.at(-1) ?? null;
      const process = items.find((event) => event.type === 'process.started');
      const resources = items.filter((event) => event.type === 'resource.accessed');
      const last = items.at(-1) ?? started;
      return {
        requestId,
        started,
        completed,
        failed,
        permission,
        permissions,
        process,
        resources,
        last,
        summary: summarizeInput(started.input),
        status: failed ? 'failed' : completed ? 'done' : 'running'
      };
    })
    .filter(Boolean)
    .sort((left, right) => new Date(left.started.timestamp) - new Date(right.started.timestamp));
}

export function statusGlyph(status) {
  if (status === 'failed') return '✗';
  if (status === 'done') return '✓';
  return '●';
}

export function statusColor(status) {
  if (status === 'failed') return 'red';
  if (status === 'done') return 'green';
  return 'yellow';
}
