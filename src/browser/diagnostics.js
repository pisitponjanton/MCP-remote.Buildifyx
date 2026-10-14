import { AgentError } from '../core/errors.js';

const MAX_EVENTS = 160;
function cleanUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '[non-http-url]';
    // Exclude credentials, query, fragment and path, any of which may contain secrets.
    return parsed.origin.slice(0, 180);
  } catch { return '[unavailable]'; }
}
const safeType = value => String(value ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);

export function createBrowserDiagnostics({ now = () => Date.now() } = {}) {
  const history = [];
  const attached = new WeakSet();
  let sequence = 0;
  function record(event) {
    history.push({ id: ++sequence, time: now(), ...event });
    if (history.length > MAX_EVENTS) history.shift();
  }
  function bindPage(page) {
    if (attached.has(page)) return;
    attached.add(page);
    page.on('console', message => {
      const type = safeType(message.type());
      record({ category: 'console', severity: type, origin: cleanUrl(message.location()?.url), redacted: true });
    });
    page.on('pageerror', error => {
      record({ category: 'pageerror', severity: 'error', errorType: safeType(error?.name), redacted: true });
    });
    page.on('requestfailed', request => {
      record({ category: 'network', severity: 'error', outcome: 'failed',
        origin: cleanUrl(request.url()), method: safeType(request.method()),
        resourceType: safeType(request.resourceType()), redacted: true });
    });
    page.on('response', response => {
      if (response.status() < 400) return;
      const request = response.request();
      record({ category: 'network', severity: 'warning', outcome: 'http_error',
        status: response.status(), origin: cleanUrl(response.url()),
        method: safeType(request.method()), resourceType: safeType(request.resourceType()), redacted: true });
    });
  }
  function connect(context) {
    if (typeof context?.on !== 'function') throw new AgentError('BROWSER_DIAGNOSTICS_FAILED', 'Browser does not support diagnostics.');
    for (const page of context.pages()) bindPage(page);
    context.on('page', bindPage);
  }
  function snapshot({ category = 'all', limit = 30, sinceId = 0 } = {}) {
    if (!['all', 'console', 'pageerror', 'network'].includes(category)
      || !Number.isInteger(limit) || limit < 1 || limit > 100
      || !Number.isSafeInteger(sinceId) || sinceId < 0)
      throw new AgentError('INVALID_INPUT', 'Invalid browser diagnostics query.');
    const selection = history.filter(event => event.id > sinceId && (category === 'all' || event.category === category));
    const events = selection.slice(-limit);
    return {
      events,
      totalRecorded: history.length,
      nextSinceId: history.length ? history[history.length - 1].id : sinceId,
      droppedByLimit: Math.max(0, selection.length - events.length),
      redacted: true
    };
  }
  return { connect, snapshot };
}
