import assert from 'node:assert/strict';
import test from 'node:test';
import { groupActivities } from '../src/tui/model.js';

test('groupActivities keeps tool name and permission details', () => {
  const events = [
    { id: '1', type: 'tool.started', requestId: 'req-1', timestamp: '2026-09-02T00:00:00.000Z', tool: 'read_file', input: { path: 'README.md' } },
    { id: '2', type: 'permission.evaluated', requestId: 'req-1', timestamp: '2026-09-02T00:00:00.010Z', category: 'read', decision: 'allow' },
    { id: '3', type: 'tool.completed', requestId: 'req-1', timestamp: '2026-09-02T00:00:00.020Z', tool: 'read_file', durationMs: 20 }
  ];

  const [activity] = groupActivities(events);
  assert.equal(activity.started.tool, 'read_file');
  assert.equal(activity.summary, 'README.md');
  assert.equal(activity.permission.category, 'read');
  assert.equal(activity.permission.decision, 'allow');
  assert.equal(activity.status, 'done');
});

test('groupActivities survives a trimmed tool.started event when a later event still identifies the tool', () => {
  const events = [
    { id: '2', type: 'tool.completed', requestId: 'req-2', timestamp: '2026-09-02T00:00:01.000Z', tool: 'list_directory', durationMs: 5 }
  ];

  const [activity] = groupActivities(events);
  assert.equal(activity.started.tool, 'list_directory');
  assert.equal(activity.status, 'done');
});
