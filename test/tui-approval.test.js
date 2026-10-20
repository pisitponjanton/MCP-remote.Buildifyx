import assert from 'node:assert/strict';
import test from 'node:test';
import { activeApproval, approvalCategoryLabel, approvalChoices, approvalImpact, approvalVisibleRows,
  defaultApprovalSelection, safeApprovalText, visibleTuiScreen } from '../src/tui/approval-view.js';
import { createApprovalQueue } from '../src/permissions/approvals.js';
import { createRemoteDashboardState } from '../src/tui/remote.js';

function request(category, toolName = 'browser_open') {
  return { category, toolName, description: 'Tool needs approval.' };
}

test('install approvals explain dependency scripts instead of displaying a generic dangerous label', () => {
  const install = { toolName: 'run_command', category: 'dangerous', evaluation: {
    operationClass: 'dependency-install', reason: 'Installs dependencies and may run package scripts on this computer.'
  } };
  assert.equal(approvalCategoryLabel(install), 'Install dependencies');
  assert.match(approvalImpact(install), /package scripts/);
  assert.equal(approvalCategoryLabel({ ...install, category: 'outsideRoot' }), 'Outside workspace');
});

test('every prompt selects Deny by default, browser approval can only be allowed once', () => {
  for (const category of ['browserSensitive', 'persistentProfile', 'browserExternal',
    'browserRead', 'browserCapture', 'imageRead', 'imageSave', 'cacheManage']) {
    const req = request(category);
    const choices = approvalChoices(req);
    assert.equal(choices.length, 2);
    assert.deepEqual(choices[0], { label: 'Allow once', action: 'allow', remember: null });
    assert.deepEqual(choices.at(-1), { label: 'Deny', action: 'deny', remember: null });
    assert.equal(choices[defaultApprovalSelection(req)].action, 'deny');
    assert.equal(choices.every(choice => choice.remember === null), true);
  }
  assert.match(approvalImpact(request('browserSensitive')), /Sensitive browser/);
  assert.match(approvalImpact(request('persistentProfile')), /Persistent browser/);
});

test('only narrow legacy rules can be remembered and never by default', () => {
  const outside = approvalChoices({ category: 'outsideRoot', toolName: 'read_file', pathInfo: { scope: 'outside' } });
  const command = approvalChoices({ category: 'command', toolName: 'run_command' });
  assert.deepEqual(outside[1], { label: 'Always allow this location', action: 'allow', remember: 'root' });
  assert.deepEqual(command[1], { label: 'Remember exact command here', action: 'allow', remember: 'command' });
  assert.equal(defaultApprovalSelection({ category: 'command', toolName: 'run_command' }), 2);
  assert.equal(approvalChoices({ category: 'outsideRoot', toolName: 'read_file', pathInfo: { scope: 'inside' } }).length, 2);
});

test('approval viewport is actionable only with sufficient terminal height', () => {
  assert.deepEqual(approvalVisibleRows(9), { canRespond: false, compact: true });
  assert.deepEqual(approvalVisibleRows(10), { canRespond: true, compact: true });
  assert.deepEqual(approvalVisibleRows(14), { canRespond: true, compact: true });
  assert.deepEqual(approvalVisibleRows(15), { canRespond: true, compact: false });
});

test('pending approval queue preserves order, removes cancelled items, and never resolves stale IDs', async () => {
  const events = [];
  const queue = createApprovalQueue({ eventBus: { emit(type, payload) { events.push({ type, payload }); } } });
  const snapshots = [];
  queue.subscribe(items => snapshots.push(items.map(item => item.id)));
  const first = queue.request({ id: 'appr-one', requestId: 'req-one', ...request('browserSensitive', 'browser_click') });
  const second = queue.request({ id: 'appr-two', requestId: 'req-two', ...request('persistentProfile') });
  assert.equal(activeApproval(queue.getPending()).id, 'appr-one');
  assert.deepEqual(queue.getPending().map(item => item.id), ['appr-one','appr-two']);
  const cancellation = Object.assign(new Error('Request cancelled'), { code: 'REQUEST_CANCELLED' });
  queue.cancel('req-one', cancellation);
  await assert.rejects(first, { code: 'REQUEST_CANCELLED' });
  assert.equal(activeApproval(queue.getPending()).id, 'appr-two');
  assert.equal(queue.resolve('appr-one', { action: 'allow', remember: null }), false, 'cancelled request must not be approved');
  assert.equal(queue.resolve('appr-two', { action: 'deny', remember: null }), true);
  assert.deepEqual(await second, { action: 'deny', remember: null });
  assert.equal(activeApproval(queue.getPending()), null);
  assert.deepEqual(snapshots.at(-1), []);
  assert.ok(events.some(e => e.type === 'permission.cancelled' && e.payload.approvalId === 'appr-one'));
});

function dashboard(approvals) {
  return { version:'0.4.0', root:'/tmp/fake', instanceId:'inst_test',
    events: [], approvals, policy:{ categories:{},additionalRoots:[],commandRules:[] },
    connection:{status:'connected'} };
}

test('attached dashboard only reports an approval after owner confirms it', async () => {
  const observed = [];
  let snapshot = dashboard([{ id:'appr-one', requestId:'req-one', ...request('browserSensitive') }]);
  const remote = createRemoteDashboardState({ instanceId:'inst_test' }, snapshot, {
    request: async (_inst, cmd, opts) => {
      if (cmd === 'approval.resolve') {
        observed.push(opts.payload);
        snapshot = dashboard([]);
        return { ok: true, resolved: true };
      }
      if (cmd === 'dashboard.snapshot') return { ok: true, dashboard: snapshot };
      throw Error('Unexpected RPC: ' + cmd);
    }
  });
  const next = [];
  remote.approvalQueue.subscribe(a => next.push(a.map(r => r.id)));
  assert.equal(await remote.approvalQueue.resolve('appr-one', { action:'allow',remember:null }), true);
  assert.deepEqual(observed, [{ approvalId:'appr-one', requestId:'appr-one', action:'allow', remember:null }]);
  assert.deepEqual(remote.approvalQueue.getPending(), []);
  assert.deepEqual(next.at(-1), []);
});

test('attached disconnected and expired approvals reject without reporting success', async () => {
  for (const response of [new Error('control disconnected'), { ok: false, error:'Already expired' },
    { ok: true, resolved: false }]) {
    const remote = createRemoteDashboardState({ instanceId:'inst_test' }, dashboard([
      { id:'appr-expired', requestId:'req-expired', ...request('persistentProfile') }
    ]), { request: async (_inst, cmd) => {
      if (cmd === 'approval.resolve') {
        if (response instanceof Error) throw response;
        return response;
      }
      if (cmd === 'dashboard.snapshot') throw new Error('disconnected');
      throw Error('Unexpected RPC');
    }, retryDelayMs:0 });
    await assert.rejects(remote.approvalQueue.resolve('appr-expired', { action:'allow', remember:null }));
  }
});

test('pending request overrides EVERY screen and returns to its prior screen afterwards', () => {
  const pending = request('browserExternal');
  for (const screen of ['dashboard', 'permissions', 'roots', 'commands', 'tools', 'help']) {
    for (const background of [false, true]) {
      assert.equal(visibleTuiScreen(screen, pending, background), 'approval');
      assert.equal(visibleTuiScreen(screen, null, background),
        background ? 'background-confirm' : screen);
    }
  }
});

test('approval text cannot inject control sequences, newline rows, or overlong text', () => {
  assert.equal(safeApprovalText('open\x1b[31m\nprivate\rfile\x7f'), 'open private file');
  assert.equal(safeApprovalText('x'.repeat(500), 30).length, 30);
  assert.equal(safeApprovalText(undefined), '');
});
