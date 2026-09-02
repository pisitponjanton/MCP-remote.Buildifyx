import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { buildifyxHome } from '../utils/home.js';

export function defaultAuditPath() {
  return path.join(buildifyxHome(), 'audit.log');
}

export function createAuditLogger({ eventBus, filePath = defaultAuditPath(), context = null }) {
  let unsubscribe;

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

  function start() {
    if (unsubscribe) return;
    unsubscribe = eventBus.subscribe((event) => {
      void writeEvent(event).catch(() => undefined);
    });
  }

  function stop() {
    unsubscribe?.();
    unsubscribe = undefined;
  }

  return { start, stop, filePath };
}
