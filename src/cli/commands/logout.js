import { logoutDevice } from '../../transport/cloud.js';
import { clearCredentials, loadCredentials } from '../../utils/credentials.js';

export async function runLogout() {
  const credentials = await loadCredentials();
  if (!credentials) {
    console.log('Not logged in.');
    return;
  }

  try {
    await logoutDevice({ cloudUrl: credentials.cloudUrl, deviceToken: credentials.deviceToken });
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      await clearCredentials();
      console.log('✓ Local sign-in removed; Buildifyx Cloud no longer accepts this device credential.');
      return;
    }
    throw new Error(`Could not revoke the device credential: ${error.message}. Local credentials were kept so you can retry logout safely.`);
  }

  await clearCredentials();
  console.log('✓ Logged out');
}
