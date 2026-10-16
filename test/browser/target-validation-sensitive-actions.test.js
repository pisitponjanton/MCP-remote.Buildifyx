import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { createRuntime } from '../../src/core/runtime.js';
import { publicToolError } from '../../src/core/errors.js';
import { normalizePolicy } from '../../src/permissions/policy.js';

async function fixture(t, browserSensitive = 'deny') {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'bdxa-browser-phase3-')));
  const root = path.join(base, 'workspace');
  await mkdir(root);
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Phase 3 target safety</title>
      <button class="duplicate">Duplicate A</button>
      <button class="duplicate">Duplicate B</button>
      <button id="hidden" style="display:none">Hidden</button>
      <button id="toggle" onclick="document.querySelector('#status').textContent='button clicked'">Click</button>
      <label><input id="plain-checkbox" type="checkbox" onchange="document.querySelector('#status').textContent='plain checked: '+this.checked">Outside form</label>
      <form onsubmit="event.preventDefault()">
        <label><input id="form-checkbox" type="checkbox" onchange="document.querySelector('#status').textContent='form checked: '+this.checked">Inside form</label>
        <input id="password" type="password">
        <button id="submit" type="submit">Submit</button>
      </form>
      <input id="readonly" readonly value="fixed">
      <input id="disabled" disabled value="disabled">
      <input id="radio" type="radio">
      <input id="file" type="file">
      <input id="editable" type="text">
      <p id="status">idle</p>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runtime = createRuntime({
    root, namespace: 'local', instanceId: 'inst_phase3_browser', principalId: 'principal_phase3',
    browserOptions: { homeDirectory: path.join(base, 'state') },
    policy: normalizePolicy({ categories: {
      browserNavigate: 'allow', browserRead: 'allow', browserInteract: 'allow',
      browserSensitive, browserExternal: 'deny'
    } }),
    interactive: false
  });
  t.after(async () => {
    await runtime.stop().catch(() => undefined);
    await new Promise(resolve => server.close(resolve));
    await rm(base, { recursive: true, force: true });
  });
  const opened = await runtime.dispatch('browser_open', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  return { runtime, sessionId: opened.sessionId };
}

const requireChromium = t => {
  if (existsSync(chromium.executablePath())) return true;
  t.skip('Playwright Chromium binary missing'); return false;
};

test('Phase 3: duplicate, missing, hidden and invalid selectors have distinct public codes', { timeout: 60000 }, async t => {
  if (!requireChromium(t)) return;
  const { runtime, sessionId } = await fixture(t);
  async function fail(selector, code, timeoutMs = 300) {
    const error = await runtime.dispatch('browser_click', {
      sessionId, target: { selector }, timeoutMs
    }).then(() => null, value => value);
    assert.equal(error?.code, code, selector + ': ' + error?.message);
    const result = publicToolError(error);
    assert.equal(result.code, code);
    assert.doesNotMatch(JSON.stringify(result), /\/private\//);
  }
  await fail('.duplicate', 'BROWSER_AMBIGUOUS_TARGET');
  await fail('#missing', 'BROWSER_TARGET_NOT_FOUND');
  await fail('#hidden', 'BROWSER_TARGET_NOT_FOUND');
  await fail('input[', 'BROWSER_INVALID_TARGET');
  assert.equal((await runtime.dispatch('browser_click', { sessionId, target: { selector: '#toggle' } })).clicked, true);
  assert.match((await runtime.dispatch('browser_snapshot', { sessionId })).text, /button clicked/);
});

test('Phase 3: regular checkbox is clickable, form checkbox requires explicit sensitive permission', { timeout: 60000 }, async t => {
  if (!requireChromium(t)) return;
  const { runtime, sessionId } = await fixture(t, 'deny');
  const plain = await runtime.dispatch('browser_click', { sessionId, target: { selector: '#plain-checkbox' } });
  assert.equal(plain.clicked, true);
  assert.match((await runtime.dispatch('browser_snapshot', { sessionId })).text, /plain checked: true/);

  await assert.rejects(runtime.dispatch('browser_click', {
    sessionId, target: { selector: '#form-checkbox' }
  }), { code: 'BROWSER_SENSITIVE_ACTION' });
  await assert.rejects(runtime.dispatch('browser_click', {
    sessionId, target: { selector: '#form-checkbox' }, confirmSensitive: true
  }), { code: 'PERMISSION_DENIED' });
  assert.doesNotMatch((await runtime.dispatch('browser_snapshot', { sessionId })).text, /form checked: true/);
});

test('Phase 3: approved form checkbox updates DOM; submit still needs a separately confirmed action', { timeout: 60000 }, async t => {
  if (!requireChromium(t)) return;
  const { runtime, sessionId } = await fixture(t, 'allow');
  const clicked = await runtime.dispatch('browser_click', {
    sessionId, target: { selector: '#form-checkbox' }, confirmSensitive: true
  });
  assert.equal(clicked.clicked, true);
  assert.match((await runtime.dispatch('browser_snapshot', { sessionId })).text, /form checked: true/);
  await assert.rejects(runtime.dispatch('browser_click', {
    sessionId, target: { selector: '#submit' }
  }), { code: 'BROWSER_SENSITIVE_ACTION' });
});

test('Phase 3: non-editable fields return targeted error while password fields remain protected', { timeout: 60000 }, async t => {
  if (!requireChromium(t)) return;
  const { runtime, sessionId } = await fixture(t);
  const fill = selector => runtime.dispatch('browser_fill', { sessionId, target: { selector }, value: 'not written' });
  for (const selector of ['#readonly', '#disabled', '#radio', '#file', '#toggle', '#plain-checkbox']) {
    await assert.rejects(fill(selector), { code: 'BROWSER_TARGET_NOT_EDITABLE' });
  }
  await assert.rejects(fill('#password'), { code: 'BROWSER_SENSITIVE_ACTION' });
  const result = await runtime.dispatch('browser_fill', {
    sessionId, target: { selector: '#editable' }, value: 'safe text'
  });
  assert.equal(result.filled, true);
  assert.equal(result.length, 9);
  assert.equal(Object.hasOwn(result, 'value'), false);
});
