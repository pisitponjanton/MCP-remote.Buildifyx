import { randomUUID } from 'node:crypto';
import { captureConfiguredPage } from '../browser/device-capture.js';
import { AgentError } from '../core/errors.js';
import { authorizeBrowserUrl, guardBrowserContext } from '../browser/network.js';
import { createBrowserDiagnostics } from '../browser/diagnostics.js';

const MAX_TABS = 5;
const MAX_LIVE = 3;
const MAX_CHARS = 12000;
function fault(code, message) { return new AgentError(code, message); }
function limitText(text, max = MAX_CHARS) { return String(text ?? '').replace(/\b(bearer\s+)[^\s]+/ig, '$1[redacted]')
  .replace(/\b(password|token|api[_-]?key|secret)(\s*[:=]\s*)[^\s&,;]+/ig, '$1$2[redacted]').slice(0, max); }
function safeUrl(value) { try { return new URL(value).origin; } catch { return '[unavailable]'; } }

export function createBrowserControlServices({ createEngine, instanceId, principalId, resolveHost, getPolicy = () => ({ categories: {} }), captureArtifact, compareScreenshots } = {}) {
  if (typeof createEngine !== 'function' || !instanceId || !principalId) throw new TypeError('Trusted browser owner and engine factory required.');
  const scope = { instanceId, principalId };
  const sessions = new Map();
  let starting = 0;
  let stopping = false;
  const closing = new Set();
  const canAccess = category => getPolicy().categories?.[category] !== 'deny';
  function ensureAccess(context, category) {
    context.throwIfCancelled?.();
    context.assertStillAllowed?.();
    if (!canAccess(category)) throw fault('PERMISSION_DENIED', 'Browser permission was revoked.');
  }

  function tabsFor(entry) {
    for (const [id, page] of entry.tabs) if (page.isClosed()) entry.tabs.delete(id);
    for (const page of entry.context.pages()) {
      if (!page.isClosed() && ![...entry.tabs.values()].includes(page)) {
        if (entry.tabs.size >= MAX_TABS) { void page.close().catch(() => undefined); continue; }
        entry.tabs.set('tab_' + randomUUID(), page);
      }
    }
    return entry.tabs;
  }
  function selectedPage(entry, tabId) {
    const tabs = tabsFor(entry);
    const key = tabId ?? entry.activeTabId ?? tabs.keys().next().value;
    const page = tabs.get(key);
    if (!page || page.isClosed()) throw fault('BROWSER_TAB_NOT_FOUND', 'Browser tab does not exist.');
    entry.activeTabId = key;
    return { page, tabId: key };
  }
  async function authorized(sessionId, fn, context) {
    const entry = sessions.get(sessionId);
    if (!entry || stopping) throw fault('BROWSER_SESSION_NOT_FOUND', 'Browser session is closed.');
    context.throwIfCancelled?.();
    return entry.engine.withSession(sessionId, ({ context: browserContext }) => {
      ensureAccess(context, 'browserRead');
      ensureAccess(context, 'browserNavigate');
      return fn(entry, browserContext);
    }, { scope });
  }
  async function goto(entry, page, url, context, timeoutMs = 12000) {
    // Browser-followed redirects after route.fulfill can skip Playwright's
    // route handler. Follow up to 8 authorized HTTP document steps here,
    // so every hop receives a fresh URL/origin check and intercept.
    let requested = url;
    for (let redirects = 0; redirects < 8; redirects++) {
      ensureAccess(context, 'browserNavigate');
      await entry.network.allowNavigation(requested, page);
      try {
        ensureAccess(context, 'browserNavigate');
        context.commitSideEffect?.();
      } catch (error) {
        entry.network.cancelNavigation(page);
        throw error;
      }
      try {
        const response = await page.goto(requested, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        context.throwIfCancelled?.();
        const redirect = entry.network.takeRedirect(page, requested);
        if (redirect) {
          // A validated redirect stub was rendered rather than allowing
          // Chromium to make an unchecked follow-up request. Repeat through
          // this trusted navigation path and preserve the final page URL.
          requested = redirect;
          continue;
        }
        if (response?.status() >= 300 && response?.status() < 400)
          throw fault('BROWSER_NAVIGATION_FAILED', 'Browser redirect was not completed.');
        if (!response && page.url() !== requested)
          throw fault('BROWSER_NAVIGATION_FAILED', 'Browser navigation did not reach the requested address.');
        const current = await authorizeBrowserUrl(page.url(), { resolve: resolveHost });
        if (!entry.network.isAllowed(current, page))
          throw fault('BROWSER_NAVIGATION_FAILED', 'Browser navigated to an unapproved origin.');
        const title = limitText(await page.title(), 240);
        context.throwIfCancelled?.();
        ensureAccess(context, 'browserNavigate');
        if (!entry.network.confirmNavigation(page, current, response))
          throw fault('BROWSER_NAVIGATION_FAILED', 'Browser did not commit the explicitly authorized document.');
        return { url: safeUrl(current), title, status: response?.status() ?? null };
      } catch (error) {
        entry.network.cancelNavigation(page);
        if (error instanceof AgentError) throw error;
        throw fault('BROWSER_NAVIGATION_FAILED', 'Browser navigation failed or timed out.');
      }
    }
    entry.network.cancelNavigation(page);
    throw fault('BROWSER_NAVIGATION_FAILED', 'Browser redirect limit was exceeded.');
  }
  async function browser_open({ kind = 'temporary', profileName, confirmPersistent, url } = {}, context = {}) {
    if (stopping) throw fault('BROWSER_STOPPING', 'Agent is shutting down.');
    if (sessions.size + starting >= MAX_LIVE) throw fault('BROWSER_SESSION_LIMIT', 'Maximum browser sessions reached.');
    if (url) await authorizeBrowserUrl(url, { resolve: resolveHost });
    if (kind === 'persistent' && (!confirmPersistent || context.persistentApproved !== true))
      throw fault('BROWSER_CONSENT_REQUIRED', 'Persistent browser profile requires a separate user approval.');
    ensureAccess(context, 'browserNavigate');
    starting++;
    let engine, started;
    try {
      engine = createEngine({ instanceId, principalId, maxSessions: 1,
        persistentConsent: async () => kind === 'persistent' && context.persistentApproved === true });
      started = await engine.open({ scope, kind, profileName, confirmPersistent });
      ensureAccess(context, 'browserNavigate');
      if (kind === 'persistent') ensureAccess(context, 'persistentProfile');
      const tabs = new Map();
      const entry = { engine, kind, tabs, activeTabId: null, context: null, diagnostics: createBrowserDiagnostics() };
      await engine.withSession(started.sessionId, async ({ context: browserContext }) => {
        entry.context = browserContext;
        entry.network = await guardBrowserContext(browserContext, { resolve: resolveHost, canAccess });
        entry.diagnostics.connect(browserContext);
        tabsFor(entry);
      }, { scope });
      sessions.set(started.sessionId, entry);
      let navigation = null;
      if (url) navigation = await authorized(started.sessionId,
        (current) => goto(current, selectedPage(current).page, url, context), context);
      const chosen = selectedPage(entry);
      return { ...started, tabId: chosen.tabId, ...(navigation ?? { url: safeUrl(chosen.page.url()) }) };
    } catch (error) {
      if (started) sessions.delete(started.sessionId);
      await engine?.closeAll().catch(() => undefined);
      throw error;
    } finally { starting--; }
  }
  async function browser_navigate({ sessionId, tabId, url, timeoutMs }, context = {}) {
    return authorized(sessionId, async entry => {
      const selected = selectedPage(entry, tabId);
      const nav = await goto(entry, selected.page, url, context, timeoutMs);
      return { sessionId, tabId: selected.tabId, ...nav };
    }, context);
  }
  async function browser_snapshot({ sessionId, tabId, maxChars = 6000 }, context = {}) {
    return authorized(sessionId, async entry => {
      ensureAccess(context, 'browserRead');
      const { page, tabId: selected } = selectedPage(entry, tabId);
      try {
        const data = await page.evaluate(max => {
          const body = document.body;
          const text = body?.innerText?.slice(0, max) ?? '';
          const elements = Array.from(document.querySelectorAll('button,a,input,textarea,select'))
            .slice(0, 100).map(el => ({
              tag: el.tagName.toLowerCase(), type: el.getAttribute('type') ?? undefined,
              name: (el.getAttribute('aria-label') ?? el.getAttribute('name') ?? el.innerText ?? '').slice(0, 120),
              disabled: el.disabled === true
            }));
          return { text, elements };
        }, Math.min(MAX_CHARS, maxChars));
        context.throwIfCancelled?.();
        return { sessionId, tabId: selected, url: safeUrl(page.url()),
          title: limitText(await page.title(), 240),
          text: limitText(data.text, maxChars), elements: data.elements.map(el => ({ ...el, name: limitText(el.name, 120) })),
          truncated: (data.text?.length ?? 0) >= maxChars };
      } catch (error) {
        if (error instanceof AgentError) throw error;
        throw fault('BROWSER_SNAPSHOT_FAILED', 'Could not safely inspect browser page.');
      }
    }, context);
  }
  function locatorFor(page, target) {
    if (target.selector) return page.locator(target.selector);
    if (target.role) return page.getByRole(target.role, { name: target.name, exact: true });
    if (target.text) return page.getByText(target.text, { exact: true });
    throw fault('BROWSER_INVALID_TARGET', 'Browser target is required.');
  }
  async function targetFor(page, target, timeoutMs = 10000) {
    const locator = locatorFor(page, target);
    try { await locator.waitFor({ state: 'visible', timeout: timeoutMs }); }
    catch (error) {
      if (error instanceof AgentError) throw error;
      throw fault('BROWSER_TARGET_NOT_FOUND', 'Browser target was not visible.');
    }
    if (await locator.count() !== 1) throw fault('BROWSER_AMBIGUOUS_TARGET', 'Target must match exactly one element.');
    const meta = await locator.evaluate(el => {
      const form = el.closest('form');
      const a = el.closest('a');
      const input = el.matches('input,textarea,select') ? el : el.querySelector('input,textarea,select');
      return {
        tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') ?? '').toLowerCase(),
        name: (el.getAttribute('aria-label') ?? el.innerText ?? '').slice(0, 150),
        href: a?.href ?? null, download: Boolean(a?.hasAttribute('download')),
        form: Boolean(form), formMethod: form?.method ?? null,
        inputType: (input?.getAttribute('type') ?? '').toLowerCase(),
        contentEditable: el.isContentEditable, readonly: Boolean(el.hasAttribute('readonly'))
      };
    });
    return { locator, meta };
  }
  function safeClick(meta, currentUrl, approved) {
    if (meta.type === 'file' || meta.download) {
      throw fault('BROWSER_SENSITIVE_ACTION', 'File uploads and downloads are not enabled by browser action approval.');
    }
    if (!approved && (meta.form || meta.type === 'submit' || meta.type === 'password'
      || meta.inputType === 'password'
      || /\b(delete|remove|purchase|pay|checkout|send|submit|confirm|sign out|logout)\b/i.test(meta.name))) {
      throw fault('BROWSER_SENSITIVE_ACTION', 'Sensitive browser interaction requires Phase 8 approval support.');
    }
    if (meta.href) {
      let target;
      try { target = new URL(meta.href); } catch { throw fault('BROWSER_SENSITIVE_ACTION', 'Unsafe link target.'); }
      if (!['https:', 'http:'].includes(target.protocol))
        throw fault('BROWSER_SENSITIVE_ACTION', 'Unsafe link protocol.');
      if (target.origin !== new URL(currentUrl).origin)
        throw fault('BROWSER_SENSITIVE_ACTION', 'Cross-origin links require an explicit browser_navigate request.');
    }
  }
  async function browser_click({ sessionId, tabId, target, timeoutMs, confirmSensitive }, context = {}) {
    return authorized(sessionId, async entry => {
      const { page, tabId: selected } = selectedPage(entry, tabId);
      const { locator, meta } = await targetFor(page, target, timeoutMs);
      const sensitive = Boolean(confirmSensitive === true || meta.form || meta.type === 'submit' || meta.download || meta.type === 'password'
        || meta.type === 'file' || meta.inputType === 'password' || /\b(delete|remove|purchase|pay|checkout|send|submit|confirm|sign out|logout)\b/i.test(meta.name));
      safeClick(meta, page.url(), confirmSensitive === true && context.sensitiveApproved === true);
      if (sensitive && (!confirmSensitive || !context.sensitiveApproved)) throw fault('BROWSER_SENSITIVE_ACTION', 'Sensitive action requires confirmation.');
      ensureAccess(context, sensitive ? 'browserSensitive' : 'browserInteract');
      context.commitSideEffect?.();
      try {
        const click = () => locator.click({ timeout: timeoutMs ?? 10000, noWaitAfter: !sensitive });
        if (sensitive) await entry.network.withMutation(page, click);
        else await entry.network.withSafeInteraction(page, click);
      }
      catch (error) {
        if (error instanceof AgentError) throw error;
        throw fault('BROWSER_CLICK_FAILED', 'Browser element could not be clicked.');
      }
      return { sessionId, tabId: selected, clicked: true, url: safeUrl(page.url()) };
    }, context);
  }
  async function browser_fill({ sessionId, tabId, target, value, timeoutMs, confirmSensitive }, context = {}) {
    return authorized(sessionId, async entry => {
      const { page, tabId: selected } = selectedPage(entry, tabId);
      const { locator, meta } = await targetFor(page, target, timeoutMs);
      const sensitive = meta.type === 'password' || meta.inputType === 'password';
      const explicitSensitive = confirmSensitive === true && context.sensitiveApproved === true;
      if (!['input', 'textarea'].includes(meta.tag) || ['file','hidden','submit','button'].includes(meta.type)
        || meta.readonly || (sensitive && (!confirmSensitive || !context.sensitiveApproved))) {
        throw fault('BROWSER_SENSITIVE_ACTION', 'Only normal text inputs and textareas may be filled.');
      }
      ensureAccess(context, sensitive ? 'browserSensitive' : 'browserInteract');
      context.commitSideEffect?.();
      try {
        const fill = () => locator.fill(value, { timeout: timeoutMs ?? 10000 });
        if (explicitSensitive) await entry.network.withMutation(page, fill);
        else await entry.network.withSafeInteraction(page, fill);
      }
      catch (error) {
        if (error instanceof AgentError) throw error;
        throw fault('BROWSER_FILL_FAILED', 'Browser field could not be filled.');
      }
      return { sessionId, tabId: selected, filled: true, ...(sensitive ? {} : { length: value.length }) };
    }, context);
  }
  async function browser_tabs({ sessionId, action = 'list', tabId }, context = {}) {
    return authorized(sessionId, async (entry, browserContext) => {
      const tabs = tabsFor(entry);
      if (action === 'new') {
        if (tabs.size >= MAX_TABS) throw fault('BROWSER_TAB_LIMIT', 'Maximum browser tabs reached.');
        context.throwIfCancelled?.();
        const page = await browserContext.newPage();
        const id = 'tab_' + randomUUID();
        tabs.set(id, page);
        entry.activeTabId = id;
      } else if (action === 'select') {
        selectedPage(entry, tabId);
      } else if (action === 'close') {
        const selected = selectedPage(entry, tabId);
        if (tabs.size === 1) throw fault('BROWSER_LAST_TAB', 'Close the browser session instead of its last tab.');
        await selected.page.close();
        tabs.delete(selected.tabId);
        entry.activeTabId = tabs.keys().next().value;
      }
      return { sessionId, activeTabId: entry.activeTabId, tabs: await Promise.all([...tabsFor(entry)].map(async ([id,page]) =>
        ({ tabId: id, url: safeUrl(page.url()), title: limitText(await page.title().catch(()=>''), 240) }))) };
    }, context);
  }
  async function browser_screenshot({ sessionId, tabId, mode = 'viewport', target, format = 'png',
    timeoutMs = 15000, label, compareToArtifactId, viewportPreset, viewport, scale = 'css', deviceScaleFactor }, context = {}) {
    ensureAccess(context, 'browserCapture');
    if (typeof captureArtifact !== 'function') throw fault('BROWSER_CAPTURE_UNAVAILABLE', 'Screenshot cache is unavailable.');
    return authorized(sessionId, async entry => {
      const { page, tabId: selected } = selectedPage(entry, tabId);
      context.throwIfCancelled?.();
      const chosenViewport = viewport ?? (
        viewportPreset === 'mobile' ? {width:390,height:844} :
        viewportPreset === 'desktop' ? {width:1440,height:900} : null
      );
      const beforeViewport = page.viewportSize();
      let restoreViewport = false;
      let buffer;
      let captureDevice = null;
      const pixelScale = scale === 'device'
        ? Number(entry.context?.options?.()?.deviceScaleFactor ?? 1) : 1;
      try {
        if (viewportPreset === 'mobile' || deviceScaleFactor !== undefined) {
          const captured = await captureConfiguredPage(page, { viewport: chosenViewport,
            deviceScaleFactor: deviceScaleFactor ?? 2, mobile: viewportPreset === 'mobile',
            mode, format, scale, timeoutMs });
          buffer = captured.buffer;
          captureDevice = { deviceScaleFactor: captured.deviceScaleFactor, mobileLayout: captured.mobileLayout };
        } else {
        if (viewportPreset && !['mobile','desktop'].includes(viewportPreset))
          throw fault('BROWSER_INVALID_VIEWPORT','Unknown screenshot viewport preset.');
        if (chosenViewport) {
          if (mode === 'element' || !Number.isInteger(chosenViewport.width) ||
              !Number.isInteger(chosenViewport.height) ||
              chosenViewport.width < 240 || chosenViewport.height < 240 ||
              chosenViewport.width > 4096 || chosenViewport.height > 4096 ||
              chosenViewport.width * chosenViewport.height * pixelScale * pixelScale > 16_000_000 ||
              !beforeViewport) {
            throw fault('BROWSER_SCREENSHOT_LIMIT','Invalid or oversized screenshot viewport.');
          }
          if (beforeViewport.width !== chosenViewport.width || beforeViewport.height !== chosenViewport.height) {
            restoreViewport = true;
            await page.setViewportSize(chosenViewport);
          }
        }
        if (!['css','device'].includes(scale) || !Number.isFinite(pixelScale) || pixelScale < 1 || pixelScale > 4)
          throw fault('BROWSER_SCREENSHOT_LIMIT','Invalid screenshot scale.');
        let options = { type: format, ...(format === 'jpeg' ? { quality: 85 } : {}),
          animations: 'disabled', caret: 'hide', timeout: timeoutMs, scale };
        if (mode === 'element') {
          if (!target) throw fault('BROWSER_INVALID_TARGET', 'Element screenshot requires a target.');
          const { locator, meta } = await targetFor(page, target, timeoutMs);
          if (meta.type === 'password' || meta.inputType === 'password' || meta.type === 'file') {
            throw fault('BROWSER_SENSITIVE_ACTION', 'Sensitive fields cannot be captured individually.');
          }
          const box = await locator.boundingBox();
          if (!box || box.width < 1 || box.height < 1 || box.width > 8192 || box.height > 8192
            || box.width * box.height > 16_000_000) throw fault('BROWSER_SCREENSHOT_LIMIT', 'Element exceeds screenshot pixel limits.');
          buffer = await locator.screenshot(options);
        } else {
          if (mode !== 'viewport' && mode !== 'fullPage') throw fault('BROWSER_INVALID_MODE', 'Invalid screenshot mode.');
          const dims = await page.evaluate(fullPage => {
            const d = document.documentElement;
            const width = fullPage ? Math.max(d.scrollWidth, window.innerWidth) : window.innerWidth;
            const height = fullPage ? Math.max(d.scrollHeight, window.innerHeight) : window.innerHeight;
            return { width, height };
          }, mode === 'fullPage');
          if (!(dims.width > 0 && dims.height > 0 && dims.width <= 8192 && dims.height <= 8192
            && dims.width * dims.height * pixelScale * pixelScale <= 16_000_000)) {
            throw fault('BROWSER_SCREENSHOT_LIMIT', 'Page exceeds screenshot pixel limits.');
          }
          buffer = await page.screenshot({ ...options, fullPage: mode === 'fullPage' });
        }
        }
      } catch (error) {
        if (error instanceof AgentError) throw error;
        throw fault('BROWSER_SCREENSHOT_FAILED', 'Unable to capture the browser page.');
      } finally {
        // The capture is temporary: never leave the user's browser layout in
        // a different viewport after an error or successful screenshot.
        if (restoreViewport) {
          try { await page.setViewportSize(beforeViewport); }
          catch { throw fault('BROWSER_VIEWPORT_RESTORE_FAILED','Unable to restore the original browser viewport.'); }
        }
      }
      ensureAccess(context, 'browserCapture');
      const screenshot = await captureArtifact(buffer, context);
      const comparison = compareToArtifactId
        ? await compareScreenshots(compareToArtifactId, screenshot.artifactId, context) : undefined;
      return { sessionId, tabId: selected, mode, label: label ?? null,
        ...(chosenViewport ? { captureViewport: chosenViewport, viewportPreset: viewportPreset ?? null } : {}),
        ...(captureDevice ?? {}),
        scale, ...screenshot, capturedAt: Date.now(),
        ...(comparison ? { comparison: { beforeArtifactId: compareToArtifactId,
          afterArtifactId: screenshot.artifactId, ...comparison } } : {}),
        message: 'Screenshot cached locally. Local MCP supports ImageContent; Cloud requires acknowledged media transfer.' };
    }, context);
  }
  async function browser_diagnostics({ sessionId, category = 'all', limit = 30, sinceId = 0 }, context = {}) {
    return authorized(sessionId, async entry => {
      ensureAccess(context, 'browserDiagnostics');
      return { sessionId, ...entry.diagnostics.snapshot({ category, limit, sinceId }) };
    }, context);
  }
  async function browser_close({ sessionId }, context = {}) {
    if (stopping) throw fault('BROWSER_STOPPING', 'Browser engine is shutting down.');
    const entry = sessions.get(sessionId);
    if (!entry) return { closed: false };
    context.throwIfCancelled?.();
    const closed = await entry.engine.closeSession(sessionId, { scope });
    sessions.delete(sessionId);
    await entry.engine.closeAll();
    return { closed };
  }
  async function closeActive({ persistentOnly = false } = {}) {
    const entries = [...sessions.entries()].filter(([, entry]) => !persistentOnly || entry.kind === 'persistent');
    for (const [id, entry] of entries) { sessions.delete(id); entry.network?.close(); }
    const task = Promise.allSettled(entries.map(([, entry]) => entry.engine.closeAll()))
      .then(done => {
        if (done.some(result => result.status === 'rejected')) {
          throw fault('BROWSER_CLEANUP_FAILED', 'Could not completely close revoked browser sessions.');
        }
        return entries.length;
      });
    closing.add(task);
    try { return await task; }
    finally { closing.delete(task); }
  }
  async function closeAll() {
    stopping = true;
    const result = await Promise.allSettled([closeActive(), ...closing]);
    if (result.some(entry => entry.status === 'rejected')) {
      throw fault('BROWSER_CLEANUP_FAILED', 'Browser shutdown did not finish cleanly.');
    }
  }
  return { browser_open, browser_navigate, browser_snapshot, browser_click, browser_fill,
    browser_tabs, browser_close, browser_screenshot, browser_diagnostics,
    closeActive, closeAll, closeBrowserControls: closeAll, get active() { return sessions.size; } };
}
