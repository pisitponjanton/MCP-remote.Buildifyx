import path from 'node:path';
import { PROFILES } from './profiles.js';

function splitWords(value) {
  return value.trim().split(/\s+/).filter(Boolean);
}

export async function executeSlashCommand(commandLine, { policyManager, setOverlay, setMessage, onQuit }) {
  const [command, ...args] = splitWords(commandLine);
  const name = command?.replace(/^\//, '').toLowerCase();

  if (!name) return;

  if (name === 'help') {
    setOverlay({ type: 'help' });
    return;
  }

  if (name === 'permissions' || name === 'permission') {
    setOverlay({ type: 'permissions', selected: 0 });
    return;
  }

  if (name === 'status') {
    setOverlay({ type: 'status' });
    return;
  }

  if (name === 'allow' || name === 'ask' || name === 'deny') {
    if (!args.length) {
      setMessage(`Usage: /${name} <command> [args prefix]`);
      return;
    }
    const [executable, ...argsPrefix] = args;
    await policyManager.addCommandRule({ executable, argsPrefix, action: name });
    setMessage(`Saved rule: ${executable} ${argsPrefix.join(' ')} → ${name}`.trim());
    return;
  }

  if (name === 'root') {
    if (!args.length) {
      setOverlay({ type: 'roots' });
      return;
    }
    const value = path.resolve(args.join(' '));
    await policyManager.addRoot(value);
    setMessage(`Added allowed root: ${value}`);
    return;
  }

  if (name === 'auto' || name === 'readonly' || name === 'fullaccess') {
    const profileName = name === 'auto' ? 'auto' : name === 'readonly' ? 'readOnly' : 'fullAccess';
    for (const [category, action] of Object.entries(PROFILES[profileName].categories)) {
      await policyManager.setCategory(category, action);
    }
    setMessage(`Permissions: ${PROFILES[profileName].label}`);
    return;
  }

  if (name === 'clear') {
    setMessage('__CLEAR__');
    return;
  }

  if (name === 'quit' || name === 'exit') {
    await onQuit();
    return;
  }

  setMessage(`Unknown command: /${name}. Type /help.`);
}
