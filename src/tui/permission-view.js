import { DEFAULT_POLICY } from '../permissions/policy.js';

export const PERMISSION_GROUPS = Object.freeze([
  Object.freeze({
    title: 'Base permissions (5)',
    categories: Object.freeze([
      ['read', 'Read files'],
      ['write', 'Write files'],
      ['command', 'Run commands'],
      ['dangerous', 'Dangerous commands'],
      ['outsideRoot', 'Outside workspace']
    ])
  }),
  Object.freeze({
    title: 'Images and cache (3)',
    categories: Object.freeze([
      ['imageRead', 'Read images'],
      ['imageSave', 'Save images'],
      ['cacheManage', 'Manage temporary cache']
    ])
  }),
  Object.freeze({
    title: 'Browser permissions (8)',
    categories: Object.freeze([
      ['browserRead', 'Inspect pages / tabs'],
      ['browserNavigate', 'Navigate browser'],
      ['browserInteract', 'Click / fill pages'],
      ['persistentProfile', 'Persistent login profile'],
      ['browserCapture', 'Capture screenshots'],
      ['browserDiagnostics', 'Browser diagnostics'],
      ['browserSensitive', 'Sensitive browser action'],
      ['browserExternal', 'External websites']
    ])
  })
]);

export const PERMISSION_CATEGORIES = Object.freeze(PERMISSION_GROUPS.flatMap(
  group => group.categories.map(([key]) => key)
));

export const PERMISSION_ROWS = Object.freeze(PERMISSION_GROUPS.flatMap(group => [
  Object.freeze({ type: 'group', label: group.title }),
  ...group.categories.map(([key, label]) => Object.freeze({ type: 'permission', key, label, group: group.title }))
]));

// A saved pre-v0.4.0 policy can contain only the five original categories.
// Rendering must use the same defaults as the evaluator, without persisting
// extra permissions or changing what the current instance has allowed.
export function effectivePermission(policy, category) {
  const decision = policy?.categories?.[category] ?? DEFAULT_POLICY.categories[category];
  return ['allow', 'ask', 'deny'].includes(decision) ? decision : 'ask';
}

export function extraPermissionSummary(policy) {
  const counts = { allow: 0, ask: 0, deny: 0 };
  for (const category of PERMISSION_CATEGORIES.slice(5)) counts[effectivePermission(policy, category)]++;
  return counts;
}

export function permissionViewport(selected, availableRows) {
  const selection = Math.max(0, Math.min(PERMISSION_CATEGORIES.length - 1, Number(selected) || 0));
  const focus = PERMISSION_ROWS.findIndex(row => row.type === 'permission'
    && row.key === PERMISSION_CATEGORIES[selection]);
  const windowSize = Math.max(1, Math.min(PERMISSION_ROWS.length, Math.floor(Number(availableRows) || 1)));
  const start = Math.max(0, Math.min(PERMISSION_ROWS.length - windowSize, focus - Math.floor(windowSize / 2)));
  return {
    selected: selection,
    group: PERMISSION_ROWS[focus].group,
    start,
    end: start + windowSize,
    rows: PERMISSION_ROWS.slice(start, start + windowSize),
    above: start > 0,
    below: start + windowSize < PERMISSION_ROWS.length
  };
}
