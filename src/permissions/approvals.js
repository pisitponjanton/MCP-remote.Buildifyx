import { randomUUID } from 'node:crypto';

function compactText(value, maxLength = 160) {
  if (typeof value !== 'string' || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…<${value.length - maxLength} more chars>`;
}

function auditSafeDetails(details) {
  const input = { ...(details.input ?? {}) };
  if (typeof input.content === 'string') input.content = `<${input.content.length} chars>`;
  if (Array.isArray(input.lines)) input.lines = `<${input.lines.length} lines>`;
  if (Array.isArray(input.args)) {
    const shown = input.args.slice(0, 12).map((arg) => compactText(arg));
    if (input.args.length > shown.length) shown.push(`<${input.args.length - shown.length} more args>`);
    input.args = shown;
  }
  return { ...details, input };
}

export function createApprovalQueue({ eventBus } = {}) {
  const pending = new Map();
  const cancelled = new Map();
  const listeners = new Set();

  function notify() {
    const requests = [...pending.values()].map(({ resolve, reject, ...request }) => request);
    for (const listener of listeners) listener(requests);
  }

  function rememberCancellation(id, error) {
    cancelled.set(id, error);
    while (cancelled.size > 500) cancelled.delete(cancelled.keys().next().value);
  }

  function request(details) {
    const id = details.id ?? randomUUID();
    const cancellation = cancelled.get(id);
    if (cancellation) {
      cancelled.delete(id);
      return Promise.reject(cancellation);
    }

    return new Promise((resolve, reject) => {
      pending.set(id, { id, createdAt: new Date().toISOString(), ...details, resolve, reject });
      eventBus?.emit('permission.requested', { requestId: id, ...auditSafeDetails(details) });
      notify();
    });
  }

  function resolveRequest(id, decision) {
    const item = pending.get(id);
    if (!item) return false;
    pending.delete(id);
    item.resolve(decision);
    eventBus?.emit('permission.resolved', { requestId: id, ...decision });
    notify();
    return true;
  }

  function cancelRequest(id, error) {
    const item = pending.get(id);
    if (!item) {
      rememberCancellation(id, error);
      eventBus?.emit('permission.cancelled', { requestId: id, reason: error?.message ?? String(error), pending: false });
      return true;
    }
    pending.delete(id);
    item.reject(error);
    eventBus?.emit('permission.cancelled', { requestId: id, reason: error?.message ?? String(error), pending: true });
    notify();
    return true;
  }

  return {
    request,
    resolve: resolveRequest,
    cancel: cancelRequest,
    getPending: () => [...pending.values()].map(({ resolve, reject, ...request }) => request),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
