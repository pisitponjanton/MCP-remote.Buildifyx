import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function defaultAuditPath() {
  return path.join(os.homedir(), '.buildifyx', 'audit.log');
}

export function createAuditLogger({ eventBus, filePath = defaultAuditPath() }) {
  let unsubscribe;

  async function writeEvent(event) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
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
