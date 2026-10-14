// Portable deterministic test runner for all supported Node.js versions,
// including Node 20.9.0, which predates --test-concurrency.
// Test files run one at a time so Local gateway ports and temp state do not race.
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const projectRoot = process.cwd();
const testsRoot = path.join(projectRoot, 'test');
const testArgs = process.argv.slice(2);

async function discover(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') files.push(...await discover(full));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(full);
  }
  return files;
}

function ensureTestFile(file) {
  const absolute = path.resolve(projectRoot, file);
  const relative = path.relative(testsRoot, absolute);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep)
    || path.isAbsolute(relative) || !relative.endsWith('.test.js')) {
    throw new Error('Only test/*.test.js files may be passed to the test runner.');
  }
  return absolute;
}

async function run(file) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', file], {
      cwd: projectRoot, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const append = data => { output = (output + data.toString()).slice(-24000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output }));
  });
}

const files = (testArgs.length ? testArgs.map(ensureTestFile) : await discover(testsRoot))
  .sort((a, b) => a.localeCompare(b));
if (!files.length) throw new Error('No test files found.');
let passed = 0;
for (const [index, file] of files.entries()) {
  const name = path.relative(projectRoot, file);
  const result = await run(file);
  if (result.code !== 0) {
    console.error('FAIL ' + name + ' (' + (result.signal ?? result.code) + ')');
    console.error(result.output);
    process.exitCode = 1;
    break;
  }
  console.log('PASS ' + name + ' (' + (index + 1) + '/' + files.length + ')');
  passed++;
}
console.log('Test files passed: ' + passed + '/' + files.length + ' — Node ' + process.version);
