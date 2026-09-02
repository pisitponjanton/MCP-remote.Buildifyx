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

  function rememberCancellation(requestId, error) {
    if (!requestId) return;
    cancelled.set(requestId, error);
    while (cancelled.size > 500) cancelled.delete(cancelled.keys().next().value);
  }

  function request(details) {
    const requestId = details.requestId ?? details.id ?? randomUUID();
    const approvalId = details.id ?? `appr_${randomUUID()}`;
    const cancellation = cancelled.get(requestId);
    if (cancellation) {
      cancelled.delete(requestId);
      return Promise.reject(cancellation);
    }

    return new Promise((resolve, reject) => {
      const { id: _ignoredId, ...rest } = details;
      pending.set(approvalId, {
        id: approvalId,
        requestId,
        createdAt: new Date().toISOString(),
        ...rest,
        resolve,
        reject
      });
      eventBus?.emit('permission.requested', {
        requestId,
        approvalId,
        ...auditSafeDetails(rest)
      });
      notify();
    });
  }

  function resolveRequest(approvalId, decision) {
    const item = pending.get(approvalId);
    if (!item) return false;
    pending.delete(approvalId);
    item.resolve(decision);
    eventBus?.emit('permission.resolved', {
      requestId: item.requestId,
      approvalId,
      ...decision
    });
    notify();
    return true;
  }

  function cancelRequest(requestId, error) {
    rememberCancellation(requestId, error);
    let cancelledCount = 0;
    for (const [approvalId, item] of pending.entries()) {
      if (item.requestId !== requestId && approvalId !== requestId) continue;
      pending.delete(approvalId);
      item.reject(error);
      cancelledCount += 1;
      eventBus?.emit('permission.cancelled', {
        requestId: item.requestId,
        approvalId,
        reason: error?.message ?? String(error),
        pending: true
      });
    }
    if (cancelledCount === 0) {
      eventBus?.emit('permission.cancelled', {
        requestId,
        reason: error?.message ?? String(error),
        pending: false
      });
    }
    notify();
    return true;
  }

  function cancelAll(error) {
    const requestIds = [...new Set([...pending.values()].map((item) => item.requestId))];
    for (const requestId of requestIds) cancelRequest(requestId, error);
    return requestIds.length > 0;
  }

  return {
    request,
    resolve: resolveRequest,
    cancel: cancelRequest,
    cancelAll,
    getPending: () => [...pending.values()].map(({ resolve, reject, ...request }) => request),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
