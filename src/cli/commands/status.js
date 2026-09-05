import { getDeviceMe } from '../../transport/cloud.js';
import { isCredentialExpired, loadCredentials } from '../../utils/credentials.js';
import { listInstances } from '../../utils/instances.js';
import { cloudEnvironment } from '../../runtime/environment.js';

function maskedPrefix(value, fallback) {
  if (typeof value === 'string' && value.trim()) return `${value.trim()}••••`;
  return fallback;
}

function printCredentialExpiries(credentials, remote = null) {
  const loginToken = remote?.loginToken ?? null;
  const loginPrefix = loginToken?.prefix ?? credentials.loginTokenPrefix ?? null;
  const loginName = loginToken?.name ?? credentials.loginTokenName ?? null;
  const hasRemoteLoginExpiry = loginToken && Object.prototype.hasOwnProperty.call(loginToken, 'expiresAt');
  const hasLocalLoginExpiry = Object.prototype.hasOwnProperty.call(credentials, 'loginTokenExpiresAt');
  const loginExpiresAt = hasRemoteLoginExpiry
    ? loginToken.expiresAt
    : hasLocalLoginExpiry
      ? credentials.loginTokenExpiresAt
      : undefined;
  const deviceExpiresAt = remote?.credential?.expiresAt ?? credentials.expiresAt ?? null;

  console.log(`  Login token     ${maskedPrefix(loginPrefix, 'bdx_login_••••')}`);
  if (loginName) console.log(`  Token name      ${loginName}`);
  console.log(`  Login expires   ${loginExpiresAt === null ? 'Never' : loginExpiresAt ?? 'Unknown'}`);
  console.log(`  Device token    ${maskedPrefix(credentials.deviceToken?.slice(0, 18), 'bdx_device_••••')}`);
  console.log(`  Device expires  ${deviceExpiresAt ?? 'Unknown'}`);
}

export async function runStatus() {
  const credentials = await loadCredentials();
  const environment = cloudEnvironment();
  const cloudInstances = await listInstances(environment.instancesDirectory, { transport: environment.kind });
  const activeInstances = cloudInstances.filter((instance) => instance.live);
  console.log('Buildifyx Desktop Agent');
  console.log('');

  if (!credentials) {
    console.log('○ Sign-in required');
    console.log('  This computer is not connected to a Buildifyx account.');
    console.log('');
    console.log('Run `bdxa login` to sign in.');
    return;
  }

  if (isCredentialExpired(credentials)) {
    console.log('! Sign-in expired');
    console.log(`  Device          ${credentials.deviceName ?? credentials.deviceId}`);
    if (credentials.account) console.log(`  Account         ${credentials.account}`);
    console.log(`  Instances       ${activeInstances.length} active`);
    printCredentialExpiries(credentials);
    console.log('');
    console.log('Run `bdxa login` to sign in again.');
    return;
  }

  try {
    const remote = await getDeviceMe({ cloudUrl: credentials.cloudUrl, deviceToken: credentials.deviceToken });
    console.log('● Ready');
    console.log('  This device credential is accepted by Buildifyx Cloud.');
    console.log('');
    console.log(`  Device          ${credentials.deviceName ?? credentials.deviceId}`);
    if (credentials.account) console.log(`  Account         ${credentials.account}`);
    console.log(`  Cloud           ${credentials.cloudUrl}`);
    console.log(`  Instances       ${activeInstances.length} active`);
    printCredentialExpiries(credentials, remote);
    if (remote?.device?.status) console.log(`  State           ${remote.device.status}`);
    console.log('');
    console.log(activeInstances.length ? 'Run `bdxa ls` to inspect active workspaces.' : 'Run `bdxa` or `bdxa -d` inside a workspace to connect it to ChatGPT.');
  } catch (error) {
    console.log('! Cloud unavailable');
    console.log('  The local credential exists, but bdxa could not verify it with Buildifyx Cloud.');
    console.log('');
    console.log(`  Device          ${credentials.deviceName ?? credentials.deviceId}`);
    console.log(`  Cloud           ${credentials.cloudUrl}`);
    console.log(`  Instances       ${activeInstances.length} active`);
    printCredentialExpiries(credentials);
    console.log(`  Reason          ${error.message}`);
  }
}
