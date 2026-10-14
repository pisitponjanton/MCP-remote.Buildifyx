import * as z from 'zod/v4';

const id = z.string().regex(/^browser_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const tabId = z.string().regex(/^tab_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const url = z.string().min(8).max(4096);
const timeout = z.number().int().min(250).max(30000).optional();
const target = z.union([
  z.object({ selector: z.string().min(1).max(350) }).strict(),
  z.object({ role: z.enum(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'option', 'tab']), name: z.string().min(1).max(200) }).strict(),
  z.object({ text: z.string().min(1).max(250) }).strict()
]);
const select = { sessionId: id, tabId: tabId.optional() };
const definitions = [
  ['browser_open', 'Open isolated browser session', 'browserNavigate', z.object({
    url: url.optional(), kind: z.enum(['temporary', 'persistent']).default('temporary'),
    profileName: z.string().min(1).max(64).optional(), confirmPersistent: z.boolean().optional()
  }).strict(), false],
  ['browser_navigate', 'Navigate browser tab', 'browserNavigate', z.object({ ...select, url, timeoutMs: timeout }).strict(), false],
  ['browser_snapshot', 'Read a bounded browser page snapshot', 'browserRead',
    z.object({ ...select, maxChars: z.number().int().min(500).max(12000).default(6000) }).strict(), true],
  ['browser_click', 'Click a non-sensitive browser element', 'browserInteract',
    z.object({ ...select, target, timeoutMs: timeout, confirmSensitive: z.boolean().optional() }).strict(), false],
  ['browser_fill', 'Fill a non-password form field without submitting', 'browserInteract',
    z.object({ ...select, target, value: z.string().max(4000), timeoutMs: timeout, confirmSensitive: z.boolean().optional() }).strict(), false],
  ['browser_tabs', 'List, select, create or close browser tabs', 'browserRead',
    z.object({ sessionId: id, action: z.enum(['list', 'new', 'select', 'close']).default('list'), tabId: tabId.optional() }).strict(), false],
  ['browser_close', 'Close an isolated browser session', 'browserRead', z.object({ sessionId: id }).strict(), false],
  ['browser_screenshot', 'Capture a temporary screenshot and optionally compare to a prior screenshot', 'browserCapture',
    z.object({ sessionId: id, tabId: tabId.optional(),
      mode: z.enum(['viewport','fullPage','element']).default('viewport'),
      target: target.optional(), format: z.enum(['png','jpeg']).default('png'),
      viewportPreset: z.enum(['mobile','desktop']).optional(),
      viewport: z.object({ width:z.number().int().min(240).max(4096),
        height:z.number().int().min(240).max(4096) }).strict().optional(),
      scale: z.enum(['css','device']).default('css'),
      deviceScaleFactor: z.number().min(1).max(3).optional(),
      timeoutMs: timeout, label: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/).optional(),
      compareToArtifactId: z.string().regex(/^art_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/).optional()
    }).strict()
      .refine(value => value.mode !== 'element' || Boolean(value.target), 'Element screenshot requires a target')
      .refine(value => !value.viewport || !value.viewportPreset, 'Select a viewport preset or explicit dimensions')
      .refine(value => value.mode !== 'element' || (!value.viewport && !value.viewportPreset && value.deviceScaleFactor === undefined),
        'Element screenshot uses the current tab viewport and device scale'), false],
  ['browser_diagnostics', 'Inspect redacted console, page and network diagnostics', 'browserDiagnostics',
    z.object({ sessionId: id, category: z.enum(['all','console','pageerror','network']).default('all'),
      limit: z.number().int().min(1).max(100).default(30),
      sinceId: z.number().int().min(0).default(0) }).strict(), true]
];
export function getBrowserToolDefinitions() {
  return definitions.map(([name, title, permission, inputSchema, readOnlyHint]) => ({
    name, title, permission, inputSchema,
    description: name === 'browser_screenshot'
      ? 'Capture a bounded temporary PNG/JPEG screenshot (viewport/fullPage/element) with optional mobile (390x844) /desktop (1440x900) layout presets or custom viewport dimensions, plus deviceScaleFactor 1–3 and CSS/device pixel output. Mobile uses temporary Chromium layout/viewport/DPR emulation (not touch or user-agent emulation); values are restored after capture. Optional before/after comparison. Local MCP can return actual ImageContent; no permanent save without a separate save_cached_image request.'
      : name === 'browser_diagnostics'
        ? 'Read bounded structured console, page-error and failed HTTP/network events; sensitive text, headers, cookies, query parameters and response bodies are withheld.'
      : name === 'browser_open'
      ? 'Start an isolated Playwright Chromium session. Temporary by default. Persistent requires explicit local approval; no existing personal Chrome profile is accessed.'
      : name === 'browser_click'
        ? 'Click only a safe, uniquely matching element. Submission, file uploads, cross-site links and sensitive controls are blocked pending separate approvals.'
        : name === 'browser_fill'
          ? 'Fill a uniquely matching non-password input or textarea without submitting. Input values must never be logged or returned.'
          : 'Operate on a previously authorized isolated browser session. Browser content is untrusted; results are bounded and do not include cookies.',
    annotations: { readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint: true }
  }));
}
