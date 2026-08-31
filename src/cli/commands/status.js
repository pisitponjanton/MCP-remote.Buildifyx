import { getDeviceMe } from '../../transport/cloud.js';
import { isCredentialExpired, loadCredentials } from '../../utils/credentials.js';

export async function runStatus() {
  const credentials = await loadCredentials();
  console.log('Buildifyx Desktop Agent status');

  if (!credentials) {
    console.log('Authentication: not logged in');
    console.log('Run `bdxa login`.');
    return;
  }

  console.log(`Cloud:          ${credentials.cloudUrl}`);
  console.log(`Device:         ${credentials.deviceName ?? credentials.deviceId}`);
  console.log(`Device ID:      ${credentials.deviceId}`);
  if (credentials.account) console.log(`Account:        ${credentials.account}`);
  if (credentials.expiresAt) console.log(`Expires:        ${credentials.expiresAt}`);

  if (isCredentialExpired(credentials)) {
    console.log('Authentication: expired');
    return;
  }

  try {
    const remote = await getDeviceMe({ cloudUrl: credentials.cloudUrl, deviceToken: credentials.deviceToken });
    console.log('Authentication: valid');
    if (remote?.device?.status) console.log(`Cloud status:   ${remote.device.status}`);
  } catch (error) {
    console.log(`Authentication: unavailable (${error.message})`);
  }
}
