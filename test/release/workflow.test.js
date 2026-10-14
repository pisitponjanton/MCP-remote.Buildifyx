import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowFile = new URL('../../.github/workflows/v040-release-matrix.yml', import.meta.url);
const loadWorkflow = () => readFile(workflowFile, 'utf8');
function stepBlock(workflow, name) {
  const marker = '      - name: ' + name + '\n';
  assert.equal(workflow.split(marker).length, 2, name + ' must appear exactly once');
  const remaining = workflow.split(marker)[1];
  const next = remaining.indexOf('      - name: ');
  return next >= 0 ? remaining.slice(0, next) : remaining;
}

test('native CI historical upgrade uses native paths and isolated tarball prefix', async () => {
  const workflow = await loadWorkflow();
  const step = stepBlock(workflow, 'Historical signed-in fixture upgrade (mock credentials only)');
  assert.match(step, /shell: pwsh/);
  assert.match(step, /\$upgrades = Join-Path \$env:RUNNER_TEMP 'bdxa-v040-upgrades'/);
  assert.match(step, /\$tarball = Join-Path \$env:RUNNER_TEMP 'buildifyx-desktop-agent-0\.4\.0\.tgz'/);
  assert.match(step, /New-Item -ItemType Directory -Force -Path \$upgrades/);
  assert.match(step, /Copy-Item -LiteralPath \$tarball -Destination \(Join-Path \$upgrades 'buildifyx-desktop-agent-0\.4\.0\.tgz'\)/);
  assert.match(step, /node scripts\/release-validate-installed\.js \$upgrades/);
  assert.doesNotMatch(step, /node scripts\/release-validate-installed\.js "\$RUNNER_TEMP"/);
});

test('native CI uses shell-safe native paths on all three supported runner OSes', async () => {
  const workflow = await loadWorkflow();
  for (const name of [
    'Fresh isolated v0.4.0 tarball installation',
    'Explicitly install matching Chromium (isolated CI path)',
    'Execute installed-package image and real browser smoke',
    'Historical signed-in fixture upgrade (mock credentials only)'
  ]) {
    const step = stepBlock(workflow, name);
    assert.match(step, /shell: pwsh/, name);
    assert.match(step, /\$env:RUNNER_TEMP/, name);
    assert.doesNotMatch(step, /"\$RUNNER_TEMP/, name + ' must not use an unconverted Bash Windows path');
  }
  const install = stepBlock(workflow, 'Fresh isolated v0.4.0 tarball installation');
  assert.match(install, /if \(\$LASTEXITCODE -ne 0\) \{ throw 'npm pack failed' \}/);
  assert.match(install, /if \(\$LASTEXITCODE -ne 0\) \{ throw 'npm tarball install failed' \}/);
  const osDeps = stepBlock(workflow, 'Linux Chromium OS dependencies (CI host only)');
  assert.match(osDeps, /if: runner\.os == 'Linux'/);
  assert.match(osDeps, /shell: bash/);
});

test('native CI retains six OS and Node combinations with full test suite', async () => {
  const workflow = await loadWorkflow();
  assert.match(workflow, /os: \[ubuntu-24\.04, windows-2022, macos-14\]/);
  assert.match(workflow, /node: \['20\.9\.0', '24\.20\.0'\]/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /run: npm ci --ignore-scripts/);
  assert.match(stepBlock(workflow, 'Execute installed-package image and real browser smoke'),
    /release-validate-browser-tarball\.js \$installed/);
});
