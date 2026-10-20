import assert from 'node:assert/strict';
import test from 'node:test';
import { runCommandMatrix } from '../../scripts/verify-command-permissions.js';

test('actual host command matrix: scoped approvals, offline installs, hard denials and execution errors', async () => {
  const rows = await runCommandMatrix();
  for (const row of rows) assert.equal(row.passed, true, JSON.stringify(row));
  assert.equal(rows.find(row => row.id === 'install-once').prompts.length, 1);
  assert.equal(rows.find(row => row.id === 'install-no-scripts').hookRan, false);
  assert.equal(rows.find(row => row.id === 'install-once').hookRan, true);
  assert.equal(rows.find(row => row.id === 'install-once').prompts[0].operationClass, 'dependency-install');
});
