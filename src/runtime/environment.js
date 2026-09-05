import path from 'node:path';
import { buildifyxHome } from '../utils/home.js';

export function createAgentEnvironment(kind = 'cloud') {
  if (!['cloud', 'local'].includes(kind)) throw new Error(`Unknown agent environment: ${kind}`);
  const rootDirectory = kind === 'local'
    ? path.join(buildifyxHome(), 'local')
    : buildifyxHome();

  return {
    kind,
    rootDirectory,
    instancesDirectory: path.join(rootDirectory, 'instances'),
    auditPath: path.join(rootDirectory, 'audit.log'),
    commandPrefix: kind === 'local' ? ['local'] : [],
    autostartNamespace: kind === 'local' ? 'local' : 'cloud',
    commandName: kind === 'local' ? 'bdxa local' : 'bdxa'
  };
}

export function cloudEnvironment() {
  return createAgentEnvironment('cloud');
}

export function localEnvironment() {
  return createAgentEnvironment('local');
}
