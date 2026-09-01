import os from 'node:os';
import path from 'node:path';

export function buildifyxHome() {
  const override = process.env.BUILDFYX_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.buildifyx');
}
