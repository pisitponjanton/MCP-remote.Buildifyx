import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentError } from '../../src/core/errors.js';
import { createBrowserControlServices } from '../../src/services/browser.js';
import { attachMockCdp } from './mock-cdp.js';

async function mockBrowser({ goto = async () => null, snapshot = async () => ({}),
  locatorWait = async () => undefined, click = async () => undefined, fill = async () => undefined,
  targetType = 'button' } = {}) {
  let currentUrl = 'about:blank';
  let page;
  const frame = { page: () => page };
  const locator = {
    waitFor: locatorWait,
    count: async () => 1,
    evaluate: async () => ({ tag: targetType, type: targetType === 'input' ? 'text' : targetType, inputType: '',
      readonly: false, form: false, name: '', download: false, href: null }),
    click, fill
  };
  page = {
    isClosed: () => false, url: () => currentUrl, mainFrame: () => frame,
    on() {}, title: async () => 'Fixture', evaluate: snapshot,
    goto: async (...args) => { const result = await goto(...args); currentUrl = args[0]; return result; },
    locator: () => locator
  };
  const context = { pages: () => [page], on() {}, off() {}, route: async () => {},
    routeWebSocket: async () => {} };
  attachMockCdp(context);
  const engine = { open: async () => ({ sessionId: 'browser_fake' }),
    withSession: async (_id, fn) => fn({ context }), closeAll: async () => {} };
  const policy = { categories: { browserNavigate: 'allow', browserRead: 'allow',
    browserInteract: 'allow', browserSensitive: 'allow' } };
  const service = createBrowserControlServices({
    createEngine: () => engine, instanceId: 'inst_p18', principalId: 'test',
    getPolicy: () => policy
  });
  const opened = await service.browser_open();
  return { service, sessionId: opened.sessionId, policy,
    setUrl: value => { currentUrl = value; } };
}

test('navigation preserves typed cancellation and permission revocation instead of navigation failure', async () => {
  for (const code of ['REQUEST_CANCELLED', 'PERMISSION_DENIED']) {
    const f = await mockBrowser({
      goto: async () => { throw new AgentError(code, 'Controlled lifecycle failure'); }
    });
    try {
      await assert.rejects(
        f.service.browser_navigate({ sessionId: f.sessionId, url: 'http://127.0.0.1:12345/' }, {
          throwIfCancelled() {}, assertStillAllowed() {}, commitSideEffect() {}
        }), { code }
      );
    } finally { await f.service.closeAll(); }
  }
});

test('snapshot preserves cancellation while Playwright exceptions retain BROWSER_SNAPSHOT_FAILED', async () => {
  for (const [failure, expected] of [
    [new AgentError('REQUEST_CANCELLED', 'Aborted'), 'REQUEST_CANCELLED'],
    [new AgentError('PERMISSION_DENIED', 'Revoked'), 'PERMISSION_DENIED'],
    [new Error('Chromium crashed'), 'BROWSER_SNAPSHOT_FAILED']
  ]) {
    const f = await mockBrowser({ snapshot: async () => { throw failure; } });
    try {
      await assert.rejects(f.service.browser_snapshot({ sessionId: f.sessionId }), { code: expected });
    } finally { await f.service.closeAll(); }
  }
});

test('browser locator/click/fill preserve typed permission and cancellation errors', async () => {
  const cases = [
    ['wait', 'browser_click', 'REQUEST_CANCELLED'],
    ['click', 'browser_click', 'PERMISSION_DENIED'],
    ['fill', 'browser_fill', 'REQUEST_CANCELLED']
  ];
  for (const [source, tool, code] of cases) {
    const opts = { targetType: tool === 'browser_fill' ? 'input' : 'button' };
    opts[source === 'wait' ? 'locatorWait' : source] = async () => {
      throw new AgentError(code, 'Lifecycle changed');
    };
    const f = await mockBrowser(opts);
    try {
      await assert.rejects(f.service[tool]({
        sessionId: f.sessionId, target: { selector: '#fixture' },
        ...(tool === 'browser_fill' ? { value: 'safe value' } : {})
      }, { throwIfCancelled() {}, assertStillAllowed() {}, commitSideEffect() {} }), { code });
    } finally { await f.service.closeAll(); }
  }
});

test('genuine untyped Playwright navigation failure still uses BROWSER_NAVIGATION_FAILED', async () => {
  const f = await mockBrowser({ goto: async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); } });
  try {
    await assert.rejects(
      f.service.browser_navigate({ sessionId: f.sessionId, url: 'http://127.0.0.1:12345/' }, {
        throwIfCancelled() {}, assertStillAllowed() {}, commitSideEffect() {}
      }), { code: 'BROWSER_NAVIGATION_FAILED' }
    );
  } finally { await f.service.closeAll(); }
});

test('policy revocation after navigation response preserves PERMISSION_DENIED and never returns success', async () => {
  let revoked = false;
  const f = await mockBrowser({ goto: async () => { revoked = true; return null; } });
  try {
    await assert.rejects(f.service.browser_navigate({
      sessionId: f.sessionId, url: 'http://127.0.0.1:12345/'
    }, {
      throwIfCancelled() {},
      assertStillAllowed() {
        if (revoked) throw new AgentError('PERMISSION_DENIED', 'Browser navigation permission was revoked');
      },
      commitSideEffect() {}
    }), { code: 'PERMISSION_DENIED' });
  } finally { await f.service.closeAll(); }
});
