import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { releaseNpmInvocation } from '../../scripts/release-npm-invocation.js';

test('POSIX historical upgrade uses argv-only npm execution', () => {
  const args = ['install', '--prefix', '/tmp/bdxa-test/installed'];
  const result = releaseNpmInvocation(args, { platform: 'linux' });
  assert.deepEqual(result, { command: 'npm', args });
  assert.notEqual(result.args, args, 'caller argv must not be mutated');
});

test('Windows historical upgrade calls node.exe npm-cli.js with no command shell', () => {
  const node = 'C:\\hostedtoolcache\\windows\\node\\20.9.0\\x64\\node.exe';
  const npm = path.win32.join(path.win32.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const args = ['install', '--prefix', 'C:\\Users\\runner\\AppData\\Local\\Temp\\bdxa\\agent032'];
  const result = releaseNpmInvocation(args, {
    platform: 'win32', execPath: node, npmExecPath: '', fileExists: candidate => candidate === npm
  });
  assert.deepEqual(result, { command: node, args: [npm, ...args] });
});

test('Windows uses only an absolute npm-cli.js fallback, never a spoofed executable', () => {
  const node = 'C:\\node\\node.exe', fallback = 'D:\\tools\\npm\\bin\\npm-cli.js';
  assert.deepEqual(releaseNpmInvocation(['--version'], {
    platform: 'win32', execPath: node, npmExecPath: fallback,
    fileExists: candidate => candidate === fallback
  }), { command: node, args: [fallback, '--version'] });
  assert.throws(() => releaseNpmInvocation(['install'], {
    platform: 'win32', execPath: node, npmExecPath: 'relative\\npm-cli.js',
    fileExists: () => false
  }), /npm-cli\.js not found/);
  assert.throws(() => releaseNpmInvocation(['install'], {
    platform: 'win32', execPath: node, npmExecPath: 'D:\\evil\\npm.cmd',
    fileExists: () => false
  }), /npm-cli\.js not found/);
});

test('release invocation rejects non-string argv without spawning a process', () => {
  assert.throws(() => releaseNpmInvocation(['install', { shell: true }]), /arguments/);
});
