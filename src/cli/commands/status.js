import { getDeviceMe } from '../../transport/cloud.js';
import { isCredentialExpired, loadCredentials } from '../../utils/credentials.js';

export async function runStatus() {
  const credentials = await loadCredentials();
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
    console.log(`  Device     ${credentials.deviceName ?? credentials.deviceId}`);
    if (credentials.account) console.log(`  Account    ${credentials.account}`);
    if (credentials.expiresAt) console.log(`  Expired    ${credentials.expiresAt}`);
    console.log('');
    console.log('Run `bdxa login` to sign in again.');
    return;
  }

  try {
    const remote = await getDeviceMe({ cloudUrl: credentials.cloudUrl, deviceToken: credentials.deviceToken });
    console.log('● Ready');
    console.log('  This device credential is accepted by Buildifyx Cloud.');
    console.log('');
    console.log(`  Device     ${credentials.deviceName ?? credentials.deviceId}`);
    if (credentials.account) console.log(`  Account    ${credentials.account}`);
    console.log(`  Cloud      ${credentials.cloudUrl}`);
    if (credentials.expiresAt) console.log(`  Expires    ${credentials.expiresAt}`);
    if (remote?.device?.status) console.log(`  State      ${remote.device.status}`);
    console.log('');
    console.log('Run `bdxa` inside a workspace to connect it to ChatGPT.');
  } catch (error) {
    console.log('! Cloud unavailable');
    console.log('  The local credential exists, but bdxa could not verify it with Buildifyx Cloud.');
    console.log('');
    console.log(`  Device     ${credentials.deviceName ?? credentials.deviceId}`);
    console.log(`  Cloud      ${credentials.cloudUrl}`);
    console.log(`  Reason     ${error.message}`);
  }
}
