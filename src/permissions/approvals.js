import { randomUUID } from 'node:crypto';

function auditSafeDetails(details) {
  const input = { ...(details.input ?? {}) };
  if (typeof input.content === 'string') input.content = `<${input.content.length} chars>`;
  if (Array.isArray(input.lines)) input.lines = `<${input.lines.length} lines>`;
  return { ...details, input };
}

export function createApprovalQueue({ eventBus } = {}) {
  const pending = new Map();
  const listeners = new Set();

  function notify() {
    const requests = [...pending.values()].map(({ resolve, ...request }) => request);
    for (const listener of listeners) listener(requests);
  }

  function request(details) {
    const id = randomUUID();
    return new Promise((resolve) => {
      pending.set(id, { id, createdAt: new Date().toISOString(), ...details, resolve });
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

  return {
    request,
    resolve: resolveRequest,
    getPending: () => [...pending.values()].map(({ resolve, ...request }) => request),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
