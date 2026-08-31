import { randomUUID } from 'node:crypto';

export function createEventBus({ maxHistory = 500 } = {}) {
  const listeners = new Set();
  const history = [];

  function emit(type, data = {}) {
    const event = {
      id: randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      ...data
    };

    history.push(event);
    if (history.length > maxHistory) history.splice(0, history.length - maxHistory);

    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Observers must never break agent execution.
      }
    }

    return event;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    emit,
    subscribe,
    getHistory: () => [...history]
  };
}
