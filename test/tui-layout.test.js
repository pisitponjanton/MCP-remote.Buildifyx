import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTuiLayout } from '../src/tui/layout.js';

test('TUI layout reserves enough rows for header, controls and status', () => {
  const layout = calculateTuiLayout({ columns: 168, rows: 54, hasUpdate: true });
  assert.equal(layout.tooSmall, false);
  assert.equal(layout.canvasRows, 53);
  assert.ok(layout.panelHeight + layout.reservedRows <= layout.canvasRows);
  assert.ok(layout.activityWindow >= 1);
});

test('narrow TUI splits the available area without overflowing', () => {
  const layout = calculateTuiLayout({ columns: 80, rows: 30, hasUpdate: false });
  assert.equal(layout.tooSmall, false);
  assert.ok((layout.panelHeight * 2) + layout.reservedRows <= layout.canvasRows);
});

test('tiny terminals use the safe fallback instead of forcing bordered panels', () => {
  const layout = calculateTuiLayout({ columns: 48, rows: 12, hasUpdate: true });
  assert.equal(layout.tooSmall, true);
  assert.equal(layout.panelHeight, 0);
  assert.equal(layout.activityWindow, 0);
});
