import { spawn, execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildifyxHome } from '../utils/home.js';
import {
  claimInstanceName,
  listInstances,
  openInstanceLog,
  releaseInstanceName,
  saveInstance,
  updateInstance
} from '../utils/instances.js';

const AUTOSTART_FILE = path.join(buildifyxHome(), 'autostart.json');
const MAC_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.buildifyx.bdxa.autostart.plist');
const LINUX_SERVICE = path.join(os.homedir(), '.config', 'systemd', 'user', 'bdxa-autostart.service');
const WINDOWS_STARTUP = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'bdxa-autostart.cmd')
  : null;

function execFileQuiet(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 5000 }, (error) => resolve(!error));
  });
}

async function loadProfiles() {
  try {
    const parsed = JSON.parse(await readFile(AUTOSTART_FILE, 'utf8'));
    return Array.isArray(parsed?.instances) ? parsed.instances : [];
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function saveProfiles(instances) {
  await mkdir(path.dirname(AUTOSTART_FILE), { recursive: true, mode: 0o700 });
  const temporary = `${AUTOSTART_FILE}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, instances }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, AUTOSTART_FILE);
  await chmod(AUTOSTART_FILE, 0o600).catch(() => undefined);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function systemdQuote(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function windowsQuote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function installPlatformHook(cliEntry) {
  if (!cliEntry) throw new Error('Could not determine bdxa CLI entrypoint for autostart.');

  if (process.platform === 'darwin') {
    await mkdir(path.dirname(MAC_PLIST), { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>com.buildifyx.bdxa.autostart</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${xmlEscape(process.execPath)}</string>\n    <string>${xmlEscape(cliEntry)}</string>\n    <string>__autostart-restore</string>\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>ProcessType</key><string>Background</string>\n</dict>\n</plist>\n`;
    await writeFile(MAC_PLIST, plist, 'utf8');
    if (typeof process.getuid === 'function') {
      const domain = `gui/${process.getuid()}`;
      await execFileQuiet('launchctl', ['bootout', domain, MAC_PLIST]);
      const installed = await execFileQuiet('launchctl', ['bootstrap', domain, MAC_PLIST]);
      if (!installed) throw new Error('launchctl could not install the bdxa autostart agent.');
    }
    return;
  }

  if (process.platform === 'linux') {
    await mkdir(path.dirname(LINUX_SERVICE), { recursive: true });
    const service = `[Unit]\nDescription=Buildifyx Desktop Agent autostart\n\n[Service]\nType=oneshot\nExecStart=${systemdQuote(process.execPath)} ${systemdQuote(cliEntry)} __autostart-restore\nRemainAfterExit=no\n\n[Install]\nWantedBy=default.target\n`;
    await writeFile(LINUX_SERVICE, service, 'utf8');
    const reloaded = await execFileQuiet('systemctl', ['--user', 'daemon-reload']);
    const enabled = reloaded && await execFileQuiet('systemctl', ['--user', 'enable', 'bdxa-autostart.service']);
    if (!enabled) throw new Error('systemd could not enable the bdxa autostart service.');
    return;
  }

  if (process.platform === 'win32') {
    if (!WINDOWS_STARTUP) throw new Error('APPDATA is unavailable; Windows autostart cannot be configured.');
    await mkdir(path.dirname(WINDOWS_STARTUP), { recursive: true });
    await writeFile(WINDOWS_STARTUP, `@echo off\r\n${windowsQuote(process.execPath)} ${windowsQuote(cliEntry)} __autostart-restore\r\n`, 'utf8');
    return;
  }

  throw new Error(`Autostart is not supported on ${process.platform}.`);
}

async function removePlatformHook() {
  if (process.platform === 'darwin') {
    if (typeof process.getuid === 'function') await execFileQuiet('launchctl', ['bootout', `gui/${process.getuid()}`, MAC_PLIST]);
    await rm(MAC_PLIST, { force: true });
    return;
  }
  if (process.platform === 'linux') {
    await execFileQuiet('systemctl', ['--user', 'disable', 'bdxa-autostart.service']);
    await rm(LINUX_SERVICE, { force: true });
    await execFileQuiet('systemctl', ['--user', 'daemon-reload']);
    return;
  }
  if (process.platform === 'win32' && WINDOWS_STARTUP) await rm(WINDOWS_STARTUP, { force: true });
}

export async function isInstanceAutostartEnabled(instanceId) {
  return (await loadProfiles()).some((profile) => profile.instanceId === instanceId);
}

export async function getAutostartInstanceIds() {
  return new Set((await loadProfiles()).map((profile) => profile.instanceId));
}

export async function setInstanceAutostart(
  profile,
  enabled,
  { cliEntry = process.argv[1], installHook = installPlatformHook, removeHook = removePlatformHook } = {}
) {
  const profiles = await loadProfiles();
  const remaining = profiles.filter((item) => item.instanceId !== profile.instanceId);

  if (enabled) {
    remaining.push({
      instanceId: profile.instanceId,
      name: profile.name,
      workspace: profile.workspace,
      unrestrictedCommands: Boolean(profile.unrestrictedCommands)
    });
    const firstProfile = profiles.length === 0;
    if (firstProfile) {
      try { await installHook(cliEntry); }
      catch (error) { await Promise.resolve(removeHook()).catch(() => undefined); throw error; }
    }
    try { await saveProfiles(remaining); }
    catch (error) {
      if (firstProfile) await Promise.resolve(removeHook()).catch(() => undefined);
      throw error;
    }
    return true;
  }

  await saveProfiles(remaining);
  if (remaining.length === 0) await removeHook();
  return false;
}

export async function removeInstanceAutostart(instanceId, { removeHook = removePlatformHook } = {}) {
  const profiles = await loadProfiles();
  if (!profiles.some((item) => item.instanceId === instanceId)) return false;
  const remaining = profiles.filter((item) => item.instanceId !== instanceId);
  await saveProfiles(remaining);
  if (remaining.length === 0) await removeHook();
  return true;
}

export async function restoreAutostartInstances({ cliEntry = process.argv[1] } = {}) {
  if (!cliEntry) throw new Error('Could not determine bdxa CLI entrypoint for autostart restore.');
  const profiles = await loadProfiles();
  if (!profiles.length) return { restored: 0, skipped: 0, failed: [] };

  const current = await listInstances();
  const currentById = new Map(current.map((item) => [item.instanceId, item]));
  const liveIds = new Set(current.filter((item) => item.live).map((item) => item.instanceId));
  let restored = 0;
  let skipped = 0;
  const failed = [];

  for (const profile of profiles) {
    if (liveIds.has(profile.instanceId)) {
      skipped += 1;
      continue;
    }

    const previous = currentById.get(profile.instanceId) ?? null;
    let handle = null;
    let child = null;
    try {
      await releaseInstanceName(profile.name, profile.instanceId).catch(() => undefined);
      await claimInstanceName(profile.workspace, profile.name, profile.instanceId);
      const opened = await openInstanceLog(profile.instanceId);
      handle = opened.handle;
      await saveInstance({
        ...(previous ?? {}),
        instanceId: profile.instanceId,
        name: profile.name,
        workspace: profile.workspace,
        mode: 'background',
        pid: 0,
        status: 'starting',
        startedAt: previous?.startedAt ?? new Date().toISOString(),
        unrestrictedCommands: Boolean(profile.unrestrictedCommands),
        logPath: opened.filePath,
        lastError: null
      });

      const args = [
        cliEntry,
        '--root', profile.workspace,
        '--instance-id', profile.instanceId,
        '--instance-name', profile.name,
        '--background-child',
        '--restart-child'
      ];
      if (profile.unrestrictedCommands) args.push('--unrestricted-commands');
      child = spawn(process.execPath, args, {
        detached: true,
        stdio: ['ignore', handle.fd, handle.fd],
        windowsHide: true,
        env: process.env
      });
      if (!child.pid) throw new Error('Could not start autostart instance.');
      child.unref();
      await updateInstance(profile.instanceId, { pid: child.pid });
      restored += 1;
    } catch (error) {
      failed.push({ instanceId: profile.instanceId, error: error?.message ?? String(error) });
      await updateInstance(profile.instanceId, { pid: 0, status: 'restart_failed', lastError: error?.message ?? String(error) }).catch(() => undefined);
      await claimInstanceName(profile.workspace, profile.name, profile.instanceId).catch(() => undefined);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  return { restored, skipped, failed };
}
