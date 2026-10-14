import { lookup } from 'node:dns/promises';
import { AgentError } from '../core/errors.js';
import { isIP } from 'node:net';
import { validateBrowserUrl } from './session-engine.js';

function denial(message) { return new AgentError('BROWSER_URL_DENIED', message); }
function withoutFragment(value) {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}
function matchesExplicitNavigation(request, expected) {
  // Playwright carries redirectedFrom() across same-origin 30x responses.
  // Do not allow a different same-origin URL from the old page to consume a
  // pending explicit navigation grant.
  let current = request;
  for (let depth = 0; current && depth < 12; depth++) {
    let url;
    try { url = new URL(current.url()); } catch { return false; }
    if (url.origin !== expected.origin) return false;
    if (withoutFragment(url.href) === expected.url) return true;
    current = current.redirectedFrom?.();
  }
  return false;
}
function publicAddress(address) {
  if (isIP(address) === 4) {
    const o = address.split('.').map(Number);
    if (o.some(x => x < 0 || x > 255)) return false;
    return o[0] !== 0 && o[0] !== 10 && o[0] !== 127 && o[0] !== 255
      && o[0] < 224 && o[0] !== 169 && !(o[0] === 172 && o[1] >= 16 && o[1] <= 31)
      && !(o[0] === 192 && (o[1] === 168 || o[1] === 0))
      && !(o[0] === 100 && o[1] >= 64 && o[1] <= 127)
      && !(o[0] === 198 && (o[1] === 18 || o[1] === 19));
  }
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    return !(a === '::' || a === '::1' || a.startsWith('fc') || a.startsWith('fd')
      || /^fe[89ab]/.test(a) || a.startsWith('ff') || a.startsWith('2001:db8')
      || a.startsWith('::ffff:'));
  }
  return false;
}
export async function authorizeBrowserUrl(value, { resolve = lookup } = {}) {
  const url = validateBrowserUrl(value);
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)) return url;
  if (isIP(host)) {
    if (!publicAddress(host)) throw denial('Browser target resolves to a protected network.');
    return url;
  }
  let addresses;
  try { addresses = await resolve(host, { all: true, verbatim: true }); }
  catch { throw denial('Browser hostname could not be safely resolved.'); }
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32
    || !addresses.every(e => publicAddress(e.address))) throw denial('Browser hostname resolves to a protected network.');
  return url;
}

// Phase 8 conservative origin firewall. An explicit browser_open/navigate authorizes
// one origin; background requests, redirects, JS redirects and popups cannot silently
// expand the allowlist. The browser can still independently resolve public DNS:
// this is NOT an OS-level egress firewall or DNS-pinning guarantee.
export async function guardBrowserContext(context, { resolve = lookup, canAccess = () => true } = {}) {
  // Never share an explicit navigation grant between tabs. The latest
  // browser_open/browser_navigate authorizes one origin for that page only.
  const origins = new Map();
  const watchedPages = new WeakSet();
  let closed = false;
  const approvedMutations = new WeakMap();
  // A safe DOM interaction must never authorize a network side effect. Once
  // clicked/filled, keep the page network-locked until an explicit navigation.
  // This also blocks delayed JS handlers, image beacons and link navigations.
  const safeLockedPages = new WeakSet();
  // Explicit navigation only unlocks a previously safe-locked tab once its
  // new main document commits; failed/pending navigation must not release
  // delayed beacons from the old document.
  const pendingNavigations = new WeakMap();
  const documentSessions = new Map();
  const dns = { resolve };
  async function watchMainDocument(page) {
    if (watchedPages.has(page)) return;
    // The Playwright 'framenavigated' event ALSO fires for history.replaceState
    // (same-document navigation), and the previous document can forge its URL.
    // Chromium's CDP Page.frameNavigated carries a distinct main-frame loaderId
    // only for a real new-document commit. No CDP = fail closed, not URL trust.
    if (typeof context.newCDPSession !== 'function')
      throw denial('Chromium document commit verification is unavailable.');
    let session;
    try {
      session = await context.newCDPSession(page);
      await session.send('Page.enable');
      const tree = await session.send('Page.getFrameTree');
      const main = tree?.frameTree?.frame;
      if (!main?.id) throw new Error('Main frame ID not available');
      let priorLoaderId = main.loaderId || null;
      session.on('Page.frameNavigated', ({ frame }) => {
        if (closed || !frame || frame.id !== main.id || frame.parentId
          || !frame.loaderId || frame.loaderId === priorLoaderId) return;
        priorLoaderId = frame.loaderId;
        const pending = pendingNavigations.get(page);
        if (!pending?.servedDocumentUrl) return;
        try {
          if (withoutFragment(frame.url) === pending.servedDocumentUrl) {
            pending.documentCommitted = true;
          }
        } catch { /* invalid new document: remain locked */ }
      });
      documentSessions.set(page, session);
      watchedPages.add(page);
      page.on?.('close', () => {
        origins.delete(page);
        pendingNavigations.delete(page);
        documentSessions.delete(page);
        void session.detach().catch(() => undefined);
      });
    } catch {
      await session?.detach().catch(() => undefined);
      throw denial('Chromium document commit verification failed.');
    }
  }
  async function allowNavigation(url, page) {
    const safe = await authorizeBrowserUrl(url, dns);
    if (closed || !canAccess('browserNavigate')) throw denial('Browser navigation permission was revoked.');
    if (!page || page.isClosed?.()) throw denial('Browser navigation requires an active tab.');
    await watchMainDocument(page);
    if (closed || !canAccess('browserNavigate')) throw denial('Browser navigation permission was revoked.');
    origins.set(page, new URL(safe).origin);
    pendingNavigations.set(page, {
      origin: new URL(safe).origin, url: withoutFragment(safe),
      servedDocumentUrl: null, documentCommitted: false, redirectTo: null
    });
    return safe;
  }
  function check(category) {
    if (closed || !canAccess(category)) throw denial('Browser access permission was revoked.');
  }
  const listener = async route => {
    try {
      check('browserNavigate');
      const request = route.request();
      const parsed = new URL(await authorizeBrowserUrl(request.url(), dns));
      // A request with no identifiable owner (popup, service worker, etc.)
      // cannot inherit an unrelated tab's navigation approval.
      let requestingPage;
      let requestingFrame;
      try {
        requestingFrame = request.frame();
        requestingPage = requestingFrame.page();
      } catch { /* no frame: fail closed */ }
      const allowedOrigin = requestingPage && origins.get(requestingPage);
      if (!allowedOrigin || allowedOrigin !== parsed.origin) throw denial('Cross-origin request was not explicitly authorized by this tab.');
      const method = request.method().toUpperCase();
      const resourceType = request.resourceType();
      // Lock only the tab that performed the safe interaction. Navigating
      // another tab must not unlock delayed beacons or links from this tab.
      const locked = safeLockedPages.has(requestingPage);
      const pending = requestingPage && pendingNavigations.get(requestingPage);
      const explicitDocumentRequest = request.isNavigationRequest()
        && resourceType === 'document' && method === 'GET'
        && !!requestingPage && !!requestingFrame
        && requestingFrame === requestingPage.mainFrame?.()
        && pending?.origin === parsed.origin
        && matchesExplicitNavigation(request, pending);
      const approvedMutation = requestingPage && (approvedMutations.get(requestingPage) ?? 0) > 0 && canAccess('browserSensitive');
      // HTTP GET is not guaranteed read-only: web apps often use GET to delete
      // or trigger mutations. Block script-driven fetch/XHR in read-only mode,
      // and every network request after a safe click/fill (including images,
      // iframe navigation and delayed requests) until explicit browser_navigate.
      // Never let the old document use the new origin during an explicit
      // navigation. This rule applies even to approved mutations: an old
      // document's GET image beacon can have server-side side effects.
      // After a validated main-document response is actually committed,
      // allow that new document's ordinary same-origin resources to bootstrap.
      if ((pending && !pending.documentCommitted && !explicitDocumentRequest)
        || (!approvedMutation && ((locked && !explicitDocumentRequest && !pending?.documentCommitted)
          || !['GET', 'HEAD'].includes(method)
          || ['fetch', 'xhr', 'eventsource', 'websocket'].includes(resourceType)))) {
        throw denial('Browser network request requires explicit sensitive-action approval or navigation.');
      }
      if (request.isNavigationRequest() && request.redirectedFrom()) {
        const previous = new URL(request.redirectedFrom().url());
        if (allowedOrigin !== previous.origin || allowedOrigin !== parsed.origin) throw denial('Redirect target is not authorized for this tab.');
      }
      check('browserNavigate');
      // Fulfill each HTTP response ourselves without following redirects. Otherwise
      // Chromium can follow a 30x behind route.continue without a fresh policy check.
      const response = await route.fetch({ maxRedirects: 0, timeout: 10000 });
      check('browserNavigate');
      let redirectLanding = null;
      if (response.status() >= 300 && response.status() < 400) {
        // Playwright's route handler is not invoked for every browser-followed
        // redirect after route.fulfill. A later hop could otherwise reach a
        // forbidden origin without ever passing this guard. Hand the first
        // validated Location back to the trusted Agent for a fresh page.goto.
        if (!explicitDocumentRequest || !pending) throw denial('Browser subresource redirects are not enabled.');
        const location = response.headers()['location'];
        if (!location) throw denial('Browser redirect has no safe destination.');
        const next = new URL(location, parsed.href);
        const allowed = await authorizeBrowserUrl(next.href, dns);
        if (allowedOrigin !== new URL(allowed).origin) throw denial('Unapproved redirect target for this tab.');
        redirectLanding = withoutFragment(allowed);
        pending.redirectTo = redirectLanding;
      }
      // A main-frame commit alone never grants access. Confirmation occurs
      // only after page.goto completes and the response redirect chain is
      // checked against the explicitly requested URL.
      // Chromium may fire framenavigated before route.fulfill resolves.
      // A validated redirect is represented as a harmless local stub at its
      // original URL, NOT a browser-followed HTTP 30x. The Agent then starts
      // the next navigation with a fresh checked origin grant.
      const finalDocument = pending && explicitDocumentRequest
        && pendingNavigations.get(requestingPage) === pending
        && ((response.status() >= 200 && response.status() < 300) || redirectLanding);
      if (finalDocument) pending.servedDocumentUrl = withoutFragment(parsed.href);
      try {
        if (redirectLanding) {
          await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<!doctype html><html><head><title>Navigation redirect</title></head><body></body></html>'
          });
        } else {
          await route.fulfill({ response });
        }
      }
      catch (error) {
        if (finalDocument) {
          pending.servedDocumentUrl = null;
          pending.documentCommitted = false;
        }
        throw error;
      }
    } catch { await route.abort('blockedbyclient').catch(() => undefined); }
  };
  await context.route('**/*', listener);
  const popup = page => {
    void page.opener().then(opener => {
      if (opener) return page.close().catch(() => undefined);
      return undefined;
    }).catch(() => undefined);
  };
  context.on('page', popup);
  // WebSockets are not covered by HTTP route interception and could exfiltrate data.
  await context.routeWebSocket?.('**/*', socket => { try { socket.close(); } catch {} });
  return {
    allowNavigation,
    takeRedirect(page, expectedUrl) {
      const pending = pendingNavigations.get(page);
      if (!pending?.redirectTo || pending.url !== withoutFragment(expectedUrl)) return null;
      const target = pending.redirectTo;
      pending.redirectTo = null;
      return target;
    },
    // A verified new-document frame commit can bootstrap its resources, but
    // never clears the safe-click lock or finalizes navigation by itself.
    // Only the trusted Agent can confirm the verified final response.
    confirmNavigation(page, value, response) {
      if (closed || !canAccess('browserNavigate') || !page || page.isClosed?.()) return false;
      const pending = pendingNavigations.get(page);
      // The synthetic redirect stub is not a completed user navigation.
      // Only the Agent may consume its validated target and follow it.
      // A null Playwright response is a same-document/history/hash navigation
      // (or another navigation with no confirmed document response). The old
      // script remains alive; never clear its network lock on URL equality.
      // Even a real response is insufficient until a distinct Chromium CDP
      // main-frame loader has committed the *route-verified* document.
      if (!pending || pending.redirectTo || !response
        || !pending.documentCommitted || !pending.servedDocumentUrl) return false;
      try {
        const committed = withoutFragment(value);
        if (committed !== withoutFragment(page.url())
          || committed !== pending.servedDocumentUrl) return false;
        // Each document redirect is reissued as a fresh Agent-checked
        // navigation. Verify the response belongs to the current hop;
        // same-document History API events cannot provide this proof.
        const request = response.request();
        if (committed !== withoutFragment(request.url())
          || !matchesExplicitNavigation(request, pending)) return false;
      } catch { return false; }
      pendingNavigations.delete(page);
      safeLockedPages.delete(page);
      return true;
    },
    isAllowed(url, page) { try { return !!page && origins.get(page) === new URL(url).origin; } catch { return false; } },
    cancelNavigation(page) {
      // Failed navigation must never leave an origin grant or an unlock
      // pending against the previous document.
      pendingNavigations.delete(page);
      origins.delete(page);
    },
    check,
    async withSafeInteraction(page, callback) {
      check('browserNavigate');
      if (!page) throw denial('Safe interaction requires a bound browser tab.');
      safeLockedPages.add(page);
      return callback();
    },
    async withMutation(page, callback) {
      check('browserSensitive');
      if (!page) throw denial('Sensitive interaction requires a bound browser tab.');
      approvedMutations.set(page, (approvedMutations.get(page) ?? 0) + 1);
      try { return await callback(); }
      finally {
        const remaining = (approvedMutations.get(page) ?? 1) - 1;
        if (remaining > 0) approvedMutations.set(page, remaining);
        else approvedMutations.delete(page);
      }
    },
    close() {
      closed = true;
      origins.clear();
      for (const session of documentSessions.values()) void session.detach().catch(() => undefined);
      documentSessions.clear();
      context.off?.('page', popup);
    },
    get allowedOriginCount() { return origins.size; }
  };
}
