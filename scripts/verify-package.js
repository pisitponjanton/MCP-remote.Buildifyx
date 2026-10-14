import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import process from 'node:process';

const run = promisify(execFile);
const npmEntrypoint = process.env.npm_execpath;
if (!npmEntrypoint) throw new Error('Run the package gate with npm run pack:check.');
const { stdout } = await run(process.execPath,
  [npmEntrypoint, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: process.cwd(), timeout: 30000, maxBuffer: 8 * 1024 * 1024
  });
const [manifest] = JSON.parse(stdout);
const paths = new Set(manifest?.files?.map(file => file.path) ?? []);
const required = [
  'package.json', 'README.md', 'LICENSE',
  'src/cli.js', 'src/cli/commands/browser.js',
  'src/browser/session-engine.js', 'src/browser/network.js',
  'src/browser/diagnostics.js', 'src/cache/store.js',
  'src/image/service.js', 'src/services/browser.js',
  'src/transport/mcp/tools/browser.js', 'src/transport/mcp/tools/images.js',
  'src/transport/media/protocol.js',
  'docs/v0.4.0-security.md', 'docs/v0.4.0-integration-tests.md'
];
const missing = required.filter(name => !paths.has(name));
const forbidden = [...paths].filter(name =>
  /(^|\/)(?:node_modules|test|tests|\.env(?:\..*)?|credentials\.json|\.git)(\/|$)/i.test(name)
  || /\.(?:log|pem|key|p12)$/i.test(name));
if (manifest?.name !== '@buildifyx/desktop-agent' || manifest.version !== '0.4.0') {
  throw new Error('npm tarball name/version does not match the v0.4.0 package contract.');
}
if (missing.length || forbidden.length) {
  throw new Error('npm pack manifest invalid. Missing: ' + missing.join(', ')
    + '; forbidden: ' + forbidden.join(', '));
}
console.log('Package dry-run verified: ' + paths.size + ' files; required code/docs present, no known sensitive files.');
