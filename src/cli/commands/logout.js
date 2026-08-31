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
    console.log(`Cloud revoke failed: ${error.message}`);
    console.log('Removing local credentials anyway.');
  }

  await clearCredentials();
  console.log('✓ Logged out');
}
