import assert from 'node:assert/strict';
import test from 'node:test';
import { printHelp } from '../../src/cli/help.js';

function captureHelp() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try { printHelp(); }
  finally { console.log = original; }
  return lines.join('\n');
}

test('CLI help lists each lifecycle command exactly once and includes disable/remove forms', () => {
  const output = captureHelp();
  const management = output.split('Manage instances:')[1]?.split('Account and maintenance:')[0] ?? '';
  const required = [
    'bdxa attach <name|id>',
    'bdxa start <name|id...>',
    'bdxa stop <name|id...>',
    'bdxa stop --all',
    'bdxa restart <name|id...>',
    'bdxa restart --all',
    'bdxa autostart <name|id>',
    'bdxa autostart off <name|id>',
    'bdxa rm <name|id...>',
    'bdxa rm -f <name|id...>',
    'bdxa rm --all'
  ];

  for (const command of required) {
    assert.equal(management.split(command).length - 1, 1, `${command} should appear exactly once in Manage instances`);
  }
});
