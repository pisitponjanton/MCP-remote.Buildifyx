import process from 'node:process';
import { createAuditLogger } from '../../audit/logger.js';
import { createRuntime } from '../../core/runtime.js';
import { createPolicyManager } from '../../permissions/manager.js';
import { loadPolicy } from '../../permissions/store.js';
import { startTui } from '../../tui/index.js';
import { startMcpServer } from '../../transport/mcp/server.js';
import { getOption, hasFlag, parsePort, resolveRoot } from '../options.js';

export async function runRemote(args) {
  const root = await resolveRoot(getOption(args, '--root', process.cwd()));
  const port = parsePort(getOption(args, '--port', '3333'));
  const fullAccess = hasFlag(args, '--full-access');
  const useTui = process.stdin.isTTY && process.stdout.isTTY && !hasFlag(args, '--no-tui');

  const policy = await loadPolicy();
  const policyManager = createPolicyManager(policy);
  const runtime = createRuntime({ root, fullAccess, policyManager, interactive: useTui });
  const audit = createAuditLogger({ eventBus: runtime.eventBus });
  audit.start();

  const server = await startMcpServer({ root, port, fullAccess, runtime, quiet: useTui });
  let closing = false;

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    audit.stop();
    await server.close();
  };

  const onSignal = async () => {
    await shutdown();
    process.exit(0);
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  if (!useTui) {
    console.log(`Audit:   ${audit.filePath}`);
    console.log(`Tools:   ${server.manifest.count} (${server.manifest.shortHash})${server.manifestState.changed ? ' CHANGED' : ''}`);
    console.log(`Tools:   ${server.toolsUrl}`);
    console.log('TUI:     disabled (Ask permissions return CONFIRMATION_REQUIRED)');
    return;
  }

  const tui = startTui({
    eventBus: runtime.eventBus,
    approvalQueue: runtime.approvalQueue,
    policyManager,
    version: server.version,
    root,
    mode: fullAccess ? 'FULL ACCESS (not sandboxed)' : 'restricted',
    auditPath: audit.filePath,
    toolManifest: server.manifest,
    toolManifestState: server.manifestState,
    toolsUrl: server.toolsUrl,
    onQuit: shutdown
  });

  await tui.waitUntilExit();
  await shutdown();
}
