import os from 'node:os';
import process from 'node:process';
import { createAuditLogger } from '../../audit/logger.js';
import { createRuntime } from '../../core/runtime.js';
import { createPolicyManager } from '../../permissions/manager.js';
import { loadPolicy } from '../../permissions/store.js';
import { startTui } from '../../tui/index.js';
import { createToolManifest } from '../../transport/mcp/tools/registry.js';
import { inspectToolManifest } from '../../transport/mcp/manifest-store.js';
import { createCloudAgent } from '../../transport/cloud.js';
import { isCredentialExpired, loadCredentials } from '../../utils/credentials.js';
import { getPackageMetadata } from '../../version.js';
import { getOption, hasFlag, resolveRoot } from '../options.js';

export async function runCloud(args) {
  const credentials = await loadCredentials();
  if (!credentials) throw new Error('Not logged in. Run `bdxa login` first.');
  if (isCredentialExpired(credentials)) throw new Error('Device credential has expired. Run `bdxa login` again.');

  const root = await resolveRoot(getOption(args, '--root', process.cwd()));
  const fullAccess = hasFlag(args, '--full-access');
  const useTui = process.stdin.isTTY && process.stdout.isTTY && !hasFlag(args, '--no-tui');
  const metadata = await getPackageMetadata();
  const policy = await loadPolicy();
  const policyManager = createPolicyManager(policy);
  const runtime = createRuntime({ root, fullAccess, policyManager, interactive: useTui });
  const audit = createAuditLogger({ eventBus: runtime.eventBus });
  const manifest = createToolManifest({ fullAccess });
  const manifestState = await inspectToolManifest(manifest);
  audit.start();

  const cloud = createCloudAgent({
    cloudUrl: credentials.cloudUrl,
    credentials,
    runtime,
    manifest,
    version: metadata.version,
    deviceInfo: {
      name: credentials.deviceName ?? os.hostname(),
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch
    },
    eventBus: runtime.eventBus
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    audit.stop();
    await cloud.stop();
  };
  const onSignal = async () => {
    await shutdown();
    process.exit(0);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  cloud.connect();

  if (!useTui) {
    console.log(`Cloud:   ${cloud.endpoint}`);
    console.log(`Device:  ${credentials.deviceName ?? credentials.deviceId}`);
    console.log(`Root:    ${root}`);
    console.log(`Audit:   ${audit.filePath}`);
    console.log(`Tools:   ${manifest.count} (${manifest.shortHash})${manifestState.changed ? ' CHANGED' : ''}`);
    console.log('TUI:     disabled (Ask permissions return CONFIRMATION_REQUIRED)');
    return;
  }

  const tui = startTui({
    eventBus: runtime.eventBus,
    approvalQueue: runtime.approvalQueue,
    policyManager,
    version: metadata.version,
    root,
    mode: fullAccess ? 'CLOUD · FULL ACCESS (not sandboxed)' : 'CLOUD · restricted',
    auditPath: audit.filePath,
    toolManifest: manifest,
    toolManifestState: manifestState,
    toolsUrl: credentials.cloudUrl,
    onQuit: shutdown
  });

  await tui.waitUntilExit();
  await shutdown();
}
