import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function defaultAuditPath() {
  return path.join(os.homedir(), '.buildifyx', 'audit.log');
}

export function createAuditLogger({ eventBus, filePath = defaultAuditPath(), context = null }) {
  let unsubscribe;

  async function writeEvent(event) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const record = context ? { ...event, instance: context } : event;
    await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
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
