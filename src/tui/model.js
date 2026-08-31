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
    if (!event.requestId || event.type.startsWith('permission.')) continue;
    if (!groups.has(event.requestId)) groups.set(event.requestId, []);
    groups.get(event.requestId).push(event);
  }

  return [...groups.entries()]
    .map(([requestId, items]) => {
      const started = items.find((event) => event.type === 'tool.started');
      if (!started) return null;
      const completed = items.find((event) => event.type === 'tool.completed');
      const failed = items.find((event) => event.type === 'tool.failed');
      const permission = items.find((event) => event.type === 'permission.evaluated');
      const process = items.find((event) => event.type === 'process.started');
      const resources = items.filter((event) => event.type === 'resource.accessed');
      const last = items.at(-1) ?? started;
      return {
        requestId,
        started,
        completed,
        failed,
        permission,
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
