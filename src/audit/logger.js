import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { buildifyxHome } from '../utils/home.js';

export function defaultAuditPath() {
  return path.join(buildifyxHome(), 'audit.log');
}

export function createAuditLogger({ eventBus, filePath = defaultAuditPath(), context = null }) {
  let unsubscribe;
  let tail = Promise.resolve();

  async function writeEvent(event) {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const record = context ? { ...event, instance: context } : event;
    const handle = await open(filePath, 'a', 0o600);
    try {
      await handle.chmod(0o600).catch(() => undefined);
      await handle.appendFile(`${JSON.stringify(record)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
  }

  function enqueue(event) {
    tail = tail.then(() => writeEvent(event)).catch(() => undefined);
  }

  function start() {
    if (unsubscribe) return;
    unsubscribe = eventBus.subscribe(enqueue);
  }

  function stop() {
    unsubscribe?.();
    unsubscribe = undefined;
  }

  async function flush() {
    await tail;
  }

  return { start, stop, flush, filePath };
}
