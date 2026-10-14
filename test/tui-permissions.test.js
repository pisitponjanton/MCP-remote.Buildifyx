import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_POLICY, normalizePolicy } from '../src/permissions/policy.js';
import { calculateTuiLayout } from '../src/tui/layout.js';
import { PERMISSION_CATEGORIES, PERMISSION_GROUPS, PERMISSION_ROWS,
  effectivePermission, extraPermissionSummary, permissionViewport } from '../src/tui/permission-view.js';
import { applyProfile, detectProfile, PROFILES } from '../src/tui/profiles.js';

test('Terminal Permissions contains exactly the evaluator\'s 16 categories in stable grouped order', () => {
  assert.equal(PERMISSION_GROUPS.length, 3);
  assert.deepEqual(PERMISSION_GROUPS.map(group => group.categories.length), [5, 3, 8]);
  assert.equal(PERMISSION_CATEGORIES.length, 16);
  assert.equal(new Set(PERMISSION_CATEGORIES).size, 16);
  assert.deepEqual([...PERMISSION_CATEGORIES].sort(), Object.keys(DEFAULT_POLICY.categories).sort());
  assert.equal(PERMISSION_ROWS.length, 19);
  assert.deepEqual(PERMISSION_ROWS.filter(row => row.type === 'group').map(row => row.label),
    ['Base permissions (5)', 'Images and cache (3)', 'Browser permissions (8)']);
  assert.ok(PERMISSION_ROWS.filter(row => row.type === 'permission').every(row => row.label && row.group));
});

test('Legacy stored policy displays effective ASK for all 11 advanced categories, without persisting changes', () => {
  const legacy = { categories: { read: 'deny', dangerous: 'allow' }, additionalRoots: [], commandRules: [] };
  const snapshot = JSON.stringify(legacy);
  assert.equal(effectivePermission(legacy, 'read'), 'deny');
  assert.equal(effectivePermission(legacy, 'dangerous'), 'allow');
  for (const category of PERMISSION_CATEGORIES.slice(5)) {
    assert.equal(effectivePermission(legacy, category), 'ask', category);
  }
  assert.deepEqual(extraPermissionSummary(legacy), { allow: 0, ask: 11, deny: 0 });
  assert.equal(JSON.stringify(legacy), snapshot);
});

test('Advanced decision summary reflects the actual effective Allow/Ask/Deny values', () => {
  const policy = normalizePolicy({ categories: {
    imageRead: 'allow', browserCapture: 'deny', browserExternal: 'allow',
    persistentProfile: 'deny'
  } });
  assert.equal(effectivePermission(policy, 'imageRead'), 'allow');
  assert.equal(effectivePermission(policy, 'persistentProfile'), 'deny');
  assert.deepEqual(extraPermissionSummary(policy), { allow: 2, ask: 7, deny: 2 });
  assert.equal(detectProfile(policy), 'auto');
  assert.match(PROFILES[detectProfile(policy)].label, /base 5/i);
});

test('Every selection remains inside its scroll viewport on normal and narrow terminals', () => {
  for (const [columns, rows] of [[160, 50], [100, 30], [80, 23], [52, 24]]) {
    const layout = calculateTuiLayout({ columns, rows });
    assert.equal(layout.tooSmall, false, `${columns}x${rows}`);
    const rowsAvailable = Math.max(1, layout.availableRows - 8);
    for (let index = 0; index < PERMISSION_CATEGORIES.length; index++) {
      const view = permissionViewport(index, rowsAvailable);
      assert.ok(view.rows.length >= 1 && view.rows.length <= rowsAvailable);
      assert.ok(view.rows.some(row => row.type === 'permission' && row.key === PERMISSION_CATEGORIES[index]),
        `${columns}x${rows}: selected ${index} not visible`);
      assert.equal(view.group, PERMISSION_ROWS.find(row => row.key === PERMISSION_CATEGORIES[index]).group);
      assert.ok(view.group.includes('permissions') || view.group.includes('cache'));
      assert.ok(view.end <= PERMISSION_ROWS.length);
      assert.equal(view.above, view.start > 0);
      assert.equal(view.below, view.end < PERMISSION_ROWS.length);
    }
  }
  assert.equal(permissionViewport(-10, 1).selected, 0);
  assert.equal(permissionViewport(999, 1).selected, 15);
});

test('A/O/F presets change ONLY five legacy categories; sensitive categories remain independent', async () => {
  for (const key of ['auto', 'readOnly', 'fullAccess']) {
    const before = normalizePolicy({ categories: {
      imageRead: 'deny', imageSave: 'ask', cacheManage: 'deny',
      browserRead: 'allow', browserNavigate: 'ask', browserInteract: 'deny',
      persistentProfile: 'deny', browserCapture: 'ask', browserDiagnostics: 'allow',
      browserSensitive: 'deny', browserExternal: 'deny'
    } });
    const advanced = Object.fromEntries(PERMISSION_CATEGORIES.slice(5).map(k => [k, before.categories[k]]));
    const calls = [];
    const manager = { async setCategory(category, action) {
      calls.push(category);
      before.categories[category] = action;
    } };
    await applyProfile(manager, key);
    assert.deepEqual(calls, PERMISSION_CATEGORIES.slice(0, 5));
    assert.deepEqual(Object.fromEntries(PERMISSION_CATEGORIES.slice(5).map(k => [k, before.categories[k]])), advanced);
    assert.equal(detectProfile(before), key);
    assert.match(PROFILES[key].label, /base 5/i);
    assert.doesNotMatch(PROFILES[key].description, /all 16.*allow/i);
  }
});
