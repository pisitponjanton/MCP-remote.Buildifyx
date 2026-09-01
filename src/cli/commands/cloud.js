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
import { runLogin } from './login.js';

async function ensureCredentials() {
  let credentials = await loadCredentials();
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  if (!credentials) {
    if (!interactive) throw new Error('This device is not signed in. Run `bdxa login` first.');

    console.log('Buildifyx Desktop Agent');
    console.log('');
    console.log('This computer is not signed in yet.');
    console.log('Sign in once, then bdxa will connect this workspace to Buildifyx Cloud.');
    console.log('');
    await runLogin([], { showConnectHint: false });
    credentials = await loadCredentials();
  }

  if (credentials && isCredentialExpired(credentials)) {
    if (!interactive) throw new Error('This device sign-in has expired. Run `bdxa login` again.');

    console.log('Your device sign-in has expired.');
    console.log('Enter a new login token to reconnect this computer.');
    console.log('');
    await runLogin([], { showConnectHint: false });
    credentials = await loadCredentials();
  }

  if (!credentials) throw new Error('Could not load the device credential after sign-in.');
  return credentials;
}

export async function runCloud(args) {
  const credentials = await ensureCredentials();
  const root = await resolveRoot(getOption(args, '--root', process.cwd()));
  const unrestrictedCommands = hasFlag(args, '--unrestricted-commands') || hasFlag(args, '--full-access');
  const useTui = process.stdin.isTTY && process.stdout.isTTY && !hasFlag(args, '--no-tui');
  const metadata = await getPackageMetadata();
  const policy = await loadPolicy();
  const policyManager = createPolicyManager(policy);
  const runtime = createRuntime({ root, fullAccess: unrestrictedCommands, policyManager, interactive: useTui });
  const audit = createAuditLogger({ eventBus: runtime.eventBus });
  const manifest = createToolManifest({ fullAccess: unrestrictedCommands });
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
    console.log('Buildifyx Desktop Agent');
    console.log('');
    console.log('● Connected');
    console.log(`  Workspace  ${root}`);
    console.log(`  Device     ${credentials.deviceName ?? credentials.deviceId}`);
    console.log(`  Cloud      ${cloud.endpoint}`);
    console.log(`  Commands   ${unrestrictedCommands ? 'Unrestricted executable names (not sandboxed)' : 'Restricted by local command policy'}`);
    console.log('');
    console.log('Interactive approvals are disabled. Requests requiring approval will return CONFIRMATION_REQUIRED.');
    return;
  }

  const tui = startTui({
    eventBus: runtime.eventBus,
    approvalQueue: runtime.approvalQueue,
    policyManager,
    version: metadata.version,
    root,
    mode: unrestrictedCommands ? 'Unrestricted commands · not sandboxed' : 'Restricted commands',
    auditPath: audit.filePath,
    toolManifest: manifest,
    toolManifestState: manifestState,
    toolsUrl: credentials.cloudUrl,
    onQuit: shutdown
  });

  await tui.waitUntilExit();
  await shutdown();
}
