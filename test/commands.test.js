import assert from 'node:assert/strict';
import test from 'node:test';
import { registerCommandTools, commandLimits } from '../src/tools/commands.js';

function captureTools() {
  const tools = new Map();
  return {
    tools,
    server: {
      registerTool(name, config, callback) {
        tools.set(name, { config, callback });
      }
    }
  };
}

test('run_command is registered as a destructive tool with bounded execution limits', () => {
  const { server, tools } = captureTools();
  registerCommandTools(server, { root: process.cwd() });

  assert.equal(tools.has('run_command'), true);
  assert.equal(tools.get('run_command').config.annotations.destructiveHint, true);
  assert.equal(commandLimits.maxTimeoutMs, 60_000);
  assert.equal(commandLimits.maxOutputBytes, 256 * 1024);
  assert.equal(commandLimits.allowedCommands.includes('git'), true);
  assert.equal(commandLimits.allowedCommands.includes('npm'), true);
});
