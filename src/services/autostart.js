import { spawn, execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildifyxHome } from '../utils/home.js';
import { cloudEnvironment } from '../runtime/environment.js';
import {
  claimInstanceName,
  listInstances,
  openInstanceLog,
  releaseInstanceName,
  saveInstance,
  updateInstance
} from '../utils/instances.js';

const AUTOSTART_FILE = path.join(buildifyxHome(), 'autostart.json');

function environmentFrom(options = {}) {
  return options.environment ?? cloudEnvironment();
}

function autostartFile(options = {}) {
  const environment = environmentFrom(options);
  return environment.kind === 'cloud' ? AUTOSTART_FILE : path.join(environment.rootDirectory, 'autostart.json');
}
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

async function loadProfiles(options = {}) {
  const filePath = autostartFile(options);
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return Array.isArray(parsed?.instances) ? parsed.instances : [];
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function saveProfiles(instances, options = {}) {
  const filePath = autostartFile(options);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, instances }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filePath);
  await chmod(filePath, 0o600).catch(() => undefined);
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

async function installPlatformHook(cliEntry, environment = cloudEnvironment()) {
  if (!cliEntry) throw new Error('Could not determine bdxa CLI entrypoint for autostart.');
  const local = environment.kind === 'local';
  const macPlist = local ? path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.buildifyx.bdxa.local-autostart.plist') : MAC_PLIST;
  const linuxService = local ? path.join(os.homedir(), '.config', 'systemd', 'user', 'bdxa-local-autostart.service') : LINUX_SERVICE;
  const linuxServiceName = local ? 'bdxa-local-autostart.service' : 'bdxa-autostart.service';
  const windowsStartup = local && process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'bdxa-local-autostart.cmd') : WINDOWS_STARTUP;
  const label = local ? 'com.buildifyx.bdxa.local-autostart' : 'com.buildifyx.bdxa.autostart';
  const restoreSuffix = local ? ' local' : '';
  const restoreXml = local ? '\n    <string>local</string>' : '';

  if (process.platform === 'darwin') {
    await mkdir(path.dirname(macPlist), { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${xmlEscape(process.execPath)}</string>\n    <string>${xmlEscape(cliEntry)}</string>\n    <string>__autostart-restore</string>${restoreXml}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>ProcessType</key><string>Background</string>\n</dict>\n</plist>\n`;
    await writeFile(macPlist, plist, 'utf8');
    if (typeof process.getuid === 'function') {
      const domain = `gui/${process.getuid()}`;
      await execFileQuiet('launchctl', ['bootout', domain, macPlist]);
      const installed = await execFileQuiet('launchctl', ['bootstrap', domain, macPlist]);
      if (!installed) throw new Error('launchctl could not install the bdxa autostart agent.');
    }
    return;
  }

  if (process.platform === 'linux') {
    await mkdir(path.dirname(linuxService), { recursive: true });
    const service = `[Unit]\nDescription=Buildifyx Desktop Agent autostart\n\n[Service]\nType=oneshot\nExecStart=${systemdQuote(process.execPath)} ${systemdQuote(cliEntry)} __autostart-restore${restoreSuffix}\nRemainAfterExit=no\n\n[Install]\nWantedBy=default.target\n`;
    await writeFile(linuxService, service, 'utf8');
    const reloaded = await execFileQuiet('systemctl', ['--user', 'daemon-reload']);
    const enabled = reloaded && await execFileQuiet('systemctl', ['--user', 'enable', linuxServiceName]);
    if (!enabled) throw new Error('systemd could not enable the bdxa autostart service.');
    return;
  }

  if (process.platform === 'win32') {
    if (!windowsStartup) throw new Error('APPDATA is unavailable; Windows autostart cannot be configured.');
    await mkdir(path.dirname(windowsStartup), { recursive: true });
    await writeFile(windowsStartup, `@echo off\r\n${windowsQuote(process.execPath)} ${windowsQuote(cliEntry)} __autostart-restore${restoreSuffix}\r\n`, 'utf8');
    return;
  }

  throw new Error(`Autostart is not supported on ${process.platform}.`);
}

async function removePlatformHook(environment = cloudEnvironment()) {
  const local = environment.kind === 'local';
  const macPlist = local ? path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.buildifyx.bdxa.local-autostart.plist') : MAC_PLIST;
  const linuxService = local ? path.join(os.homedir(), '.config', 'systemd', 'user', 'bdxa-local-autostart.service') : LINUX_SERVICE;
  const linuxServiceName = local ? 'bdxa-local-autostart.service' : 'bdxa-autostart.service';
  const windowsStartup = local && process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'bdxa-local-autostart.cmd') : WINDOWS_STARTUP;
  if (process.platform === 'darwin') {
    if (typeof process.getuid === 'function') await execFileQuiet('launchctl', ['bootout', `gui/${process.getuid()}`, macPlist]);
    await rm(macPlist, { force: true });
    return;
  }
  if (process.platform === 'linux') {
    await execFileQuiet('systemctl', ['--user', 'disable', linuxServiceName]);
    await rm(linuxService, { force: true });
    await execFileQuiet('systemctl', ['--user', 'daemon-reload']);
    return;
  }
  if (process.platform === 'win32' && windowsStartup) await rm(windowsStartup, { force: true });
}

export async function isInstanceAutostartEnabled(instanceId, options = {}) {
  return (await loadProfiles(options)).some((profile) => profile.instanceId === instanceId);
}

export async function getAutostartInstanceIds(options = {}) {
  return new Set((await loadProfiles(options)).map((profile) => profile.instanceId));
}

export async function setInstanceAutostart(profile, enabled, options = {}) {
  const environment = environmentFrom(options);
  const cliEntry = options.cliEntry ?? process.argv[1];
  const installHook = options.installHook ?? ((entry) => installPlatformHook(entry, environment));
  const removeHook = options.removeHook ?? (() => removePlatformHook(environment));
  const profiles = await loadProfiles(options);
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
    try { await saveProfiles(remaining, options); }
    catch (error) {
      if (firstProfile) await Promise.resolve(removeHook()).catch(() => undefined);
      throw error;
    }
    return true;
  }

  await saveProfiles(remaining, options);
  if (remaining.length === 0) await removeHook();
  return false;
}

export async function removeInstanceAutostart(instanceId, options = {}) {
  const environment = environmentFrom(options);
  const removeHook = options.removeHook ?? (() => removePlatformHook(environment));
  const profiles = await loadProfiles(options);
  if (!profiles.some((item) => item.instanceId === instanceId)) return false;
  const remaining = profiles.filter((item) => item.instanceId !== instanceId);
  await saveProfiles(remaining, options);
  if (remaining.length === 0) await removeHook();
  return true;
}

export async function restoreAutostartInstances(options = {}) {
  const environment = environmentFrom(options);
  const cliEntry = options.cliEntry ?? process.argv[1];
  if (!cliEntry) throw new Error('Could not determine bdxa CLI entrypoint for autostart restore.');
  const profiles = await loadProfiles(options);
  if (!profiles.length) return { restored: 0, skipped: 0, failed: [] };

  const current = await listInstances(environment.instancesDirectory, { transport: environment.kind });
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
      await releaseInstanceName(profile.name, profile.instanceId, environment.instancesDirectory).catch(() => undefined);
      await claimInstanceName(profile.workspace, profile.name, profile.instanceId, environment.instancesDirectory);
      const opened = await openInstanceLog(profile.instanceId, environment.instancesDirectory);
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
      }, environment.instancesDirectory);

      const args = [
        cliEntry,
        ...environment.commandPrefix,
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
      await updateInstance(profile.instanceId, { pid: child.pid }, environment.instancesDirectory);
      restored += 1;
    } catch (error) {
      failed.push({ instanceId: profile.instanceId, error: error?.message ?? String(error) });
      await updateInstance(profile.instanceId, { pid: 0, status: 'restart_failed', lastError: error?.message ?? String(error) }, environment.instancesDirectory).catch(() => undefined);
      await claimInstanceName(profile.workspace, profile.name, profile.instanceId, environment.instancesDirectory).catch(() => undefined);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  return { restored, skipped, failed };
}
