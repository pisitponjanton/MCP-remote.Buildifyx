import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { detectProfile, PROFILES } from './profiles.js';
import { groupActivities, shortTime, statusColor, statusGlyph } from './model.js';
import { useTuiLayout } from './layout.js';

const h = React.createElement;
const ACTIONS = ['allow', 'ask', 'deny'];
const CATEGORIES = ['read', 'write', 'command', 'dangerous', 'outsideRoot'];
const CATEGORY_LABELS = Object.freeze({
  read: 'Read files',
  write: 'Write files',
  command: 'Run commands',
  dangerous: 'Dangerous commands',
  outsideRoot: 'Outside workspace'
});

function cycleAction(current, direction) {
  const index = ACTIONS.indexOf(current);
  return ACTIONS[(index + direction + ACTIONS.length) % ACTIONS.length];
}

function title(text) {
  return h(Text, { bold: true }, text);
}

function approvalChoices(request) {
  const choices = [{ label: 'Allow once', action: 'allow', remember: null }];
  if (request.category === 'outsideRoot' && request.pathInfo?.scope === 'outside') {
    choices.push({ label: 'Always allow this location', action: 'allow', remember: 'root' });
  } else if (request.toolName === 'run_command') {
    choices.push({ label: 'Always allow this command', action: 'allow', remember: 'command' });
  }
  choices.push({ label: 'Deny', action: 'deny', remember: null });
  return choices;
}

function approvalImpact(request) {
  if (request.category === 'dangerous') return 'This action is classified as dangerous and may make significant changes.';
  if (request.pathInfo?.scope === 'outside') return 'This action needs access outside the current workspace.';
  if (request.category === 'write') return 'This action can modify files.';
  if (request.category === 'command') return 'This action will run a command on this computer.';
  return request.evaluation?.reason ?? request.category;
}

function Header({ version, root, instanceName, instanceId, mode, profile, pendingCount, connectionStatus, updateStatus }) {
  const connection = pendingCount
    ? `● APPROVAL ${pendingCount}`
    : connectionStatus === 'connected'
      ? '● CONNECTED'
      : connectionStatus === 'reconnecting'
        ? '◐ RECONNECTING'
        : connectionStatus === 'revoked'
          ? '● REVOKED'
          : connectionStatus === 'disconnected'
            ? '○ DISCONNECTED'
            : '◐ CONNECTING';
  const access = `${PROFILES[profile].label} · ${mode}`;
  const shortId = String(instanceId ?? '').replace(/^inst_/, '').slice(0, 8);
  const latestVersion = updateStatus?.updateAvailable ? updateStatus.latestVersion : null;
  const updateLine = updateStatus?.restartRequired
    ? `Restart    running v${updateStatus.runningVersion ?? version} · installed v${updateStatus.installedVersion ?? version} · bdxa restart ${shortId || instanceName}`
    : latestVersion
      ? `Update     v${version} → v${latestVersion} · run bdxa update`
      : null;

  return h(Box, { flexDirection: 'column', marginBottom: 1 },
    h(Box, { justifyContent: 'space-between' },
      h(Text, { bold: true, wrap: 'truncate-end' }, 'Buildifyx Desktop Agent'),
      h(Text, { bold: true }, connection)
    ),
    h(Text, { wrap: 'truncate-end' }, `Version    v${version}`),
    h(Text, { wrap: 'truncate-end' }, `Instance   ${instanceName}${shortId ? ` · ${shortId}` : ''}`),
    h(Text, { wrap: 'truncate-end' }, `Workspace  ${root}`),
    h(Text, { wrap: 'truncate-end' }, `Access     ${access}`),
    updateLine ? h(Text, { color: 'yellow', bold: true, wrap: 'truncate-end' }, updateLine) : null
  );
}

function ActivityPanel({ activities, selected, layout }) {
  const windowSize = layout.activityWindow;
  const half = Math.floor(windowSize / 2);
  const start = Math.max(0, Math.min(Math.max(0, activities.length - windowSize), selected - half));
  const visible = activities.slice(start, start + windowSize);

  return h(Box, { width: layout.activityWidth, borderStyle: 'classic', paddingX: 1, flexDirection: 'column', height: layout.panelHeight },
    title('RECENT ACTIVITY'),
    visible.length === 0
      ? h(Text, { dimColor: true }, 'Waiting for requests from ChatGPT...')
      : visible.map((item, localIndex) => {
          const actualIndex = start + localIndex;
          const active = actualIndex === selected;
          return h(Box, { key: item.requestId, flexDirection: 'column', marginBottom: layout.compact ? 0 : 1 },
            h(Box, null,
              h(Text, { bold: active }, active ? '› ' : '  '),
              h(Text, { dimColor: !active }, `${shortTime(item.started.timestamp)} `),
              h(Text, { color: statusColor(item.status), bold: active }, `${statusGlyph(item.status)} `),
              h(Text, { bold: active }, `TOOL ${item.started.tool}`)
            ),
            item.summary ? h(Text, { dimColor: !active, wrap: 'truncate-end' }, `    ${item.summary}`) : null
          );
        })
  );
}

function RequestDetails({ item, compact, maxRows = Number.POSITIVE_INFINITY }) {
  if (!item) return h(Text, { dimColor: true }, 'No request selected yet.');
  const resourceLimit = compact ? 3 : 7;
  const resources = item.resources.slice(-resourceLimit);
  const lines = [
    h(Text, { key: 'tool', wrap: 'truncate-end' }, `Tool:       ${item.started.tool}`),
    h(Text, { key: 'status', wrap: 'truncate-end' }, `Status:     ${item.status.toUpperCase()}`),
    item.summary ? h(Text, { key: 'request', wrap: 'truncate-end' }, `Request:    ${item.summary}`) : null,
    item.permission ? h(Text, { key: 'permission', wrap: 'truncate-end' }, `Permission: ${item.permission.category} → ${item.permission.decision}`) : null,
    item.process ? h(Text, { key: 'command', wrap: 'truncate-end' }, `Command:    ${item.process.command} ${(item.process.args ?? []).join(' ')}`) : null,
    item.process ? h(Text, { key: 'cwd', wrap: 'truncate-end' }, `Cwd:        ${item.process.cwd}`) : null,
    ...resources.map((resource) => h(Text, { key: resource.id, wrap: 'truncate-end' }, `${String(resource.operation).toUpperCase().padEnd(11)} ${resource.path}`)),
    item.resources.length > resources.length ? h(Text, { key: 'resources-more', dimColor: true, wrap: 'truncate-end' }, `… ${item.resources.length - resources.length} more resources`) : null,
    item.completed ? h(Text, { key: 'duration', wrap: 'truncate-end' }, `Duration:   ${item.completed.durationMs} ms`) : null,
    item.failed ? h(Text, { key: 'error', wrap: 'truncate-end' }, `Error:      ${item.failed.error?.code ?? 'ERROR'}`) : null,
    item.failed && !compact ? h(Text, { key: 'error-message', wrap: 'truncate-end' }, `            ${item.failed.error?.message ?? 'Request failed'}`) : null
  ].filter(Boolean);
  const limit = Math.max(1, maxRows);
  const visible = lines.length <= limit ? lines : [...lines.slice(0, Math.max(0, limit - 1)), h(Text, { key: 'details-more', dimColor: true }, '… more details')];
  return h(Box, { flexDirection: 'column' }, ...visible);
}

function ApprovalPanel({ request, selected, attached = false, compact = false }) {
  const choices = approvalChoices(request);
  const choiceLines = choices.map((choice, index) => h(Text, { key: choice.label, bold: selected === index, wrap: 'truncate-end' }, `${selected === index ? '›' : ' '} ${choice.label}`));
  if (compact) {
    return h(Box, { flexDirection: 'column' },
      h(Text, { bold: true }, 'APPROVAL REQUIRED'),
      h(Text, { bold: true, wrap: 'truncate-end' }, request.description),
      request.pathInfo ? h(Text, { wrap: 'truncate-end' }, `Location  ${request.pathInfo.resolved}`) : null,
      h(Text, { dimColor: true, wrap: 'truncate-end' }, approvalImpact(request)),
      ...choiceLines,
      h(Text, { dimColor: true, wrap: 'truncate-end' }, `↑↓ Select  Enter Confirm  Q Deny  Ctrl+C ${attached ? 'Detach' : 'Stop'}`)
    );
  }
  return h(Box, { flexDirection: 'column' },
    h(Text, { bold: true }, 'APPROVAL REQUIRED'),
    h(Text, null, ''),
    h(Text, { bold: true, wrap: 'wrap' }, request.description),
    request.pathInfo ? h(Text, { wrap: 'truncate-end' }, `Location  ${request.pathInfo.resolved}`) : null,
    h(Text, { dimColor: true, wrap: 'wrap' }, approvalImpact(request)),
    h(Text, null, ''),
    ...choiceLines,
    h(Text, null, ''),
    h(Text, { dimColor: true }, `↑↓ Select   Enter Confirm   Q Back/Deny   Ctrl+C ${attached ? 'Detach' : 'Stop'}`)
  );
}

function StatusPanel({ selectedItem, request, approvalSelected, layout, attached = false }) {
  const detailRows = Math.max(1, layout.panelHeight - 3);
  return h(Box, { width: layout.statusWidth, borderStyle: 'classic', paddingX: 1, flexDirection: 'column', height: layout.panelHeight },
    request
      ? h(ApprovalPanel, { request, selected: approvalSelected, attached, compact: layout.compact })
      : h(React.Fragment, null, title('DETAILS'), h(RequestDetails, { item: selectedItem, compact: layout.compact, maxRows: detailRows }))
  );
}

function Controls({ screen, inputMode, compact, attached = false, canBackground = false, backgroundConfirm = false }) {
  const exitLabel = attached ? 'Ctrl+C Detach' : 'Ctrl+C Stop';
  let lines;
  if (backgroundConfirm) lines = ['Enter Confirm background   Q Back   Ctrl+C Stop'];
  else if (inputMode) lines = [`Enter Save   Q on empty input Back   ${exitLabel}`];
  else if (screen === 'permissions') lines = ['↑↓ Select   ←→ Change   A Auto   O Read-only   F Allow-all', `R Roots   C Command rules   Q Back   ${exitLabel}`];
  else if (screen === 'roots') lines = [`↑↓ Select   A Add root   D Delete root   Q Back   ${exitLabel}`];
  else if (screen === 'commands') lines = [`↑↓ Select   ←→ Change   A Add rule   D Delete rule   Q Back   ${exitLabel}`];
  else if (screen === 'tools') lines = [`Q Back   ${exitLabel}`];
  else if (screen === 'help') lines = [`Q Back   ${exitLabel}`];
  else if (compact) lines = [`↑↓ Activity   P Permissions   ? Help${canBackground ? '   D Background' : ''}   ${exitLabel}`];
  else lines = [
    `↑↓ Activity   P Permissions   ? Help   Q Back${canBackground ? '   D Background' : ''}   ${exitLabel}`,
    'R Allowed roots   C Command rules   T Diagnostics'
  ];

  return h(Box, { borderStyle: 'classic', paddingX: 1, flexDirection: 'column' },
    ...lines.map((line) => h(Text, { key: line, wrap: 'truncate-end' }, line))
  );
}

function PermissionsScreen({ policy, selected }) {
  return h(Box, { borderStyle: 'classic', paddingX: 1, flexDirection: 'column', flexGrow: 1 },
    title('PERMISSIONS'),
    h(Text, { dimColor: true }, 'Choose what ChatGPT can do automatically. ASK requires local approval.'),
    h(Text, null, ''),
    ...CATEGORIES.map((category, index) => h(Box, { key: category },
      h(Text, { bold: index === selected }, `${index === selected ? '›' : ' '} ${CATEGORY_LABELS[category].padEnd(20)}`),
      h(Text, { bold: index === selected }, `[ ${String(policy.categories[category]).toUpperCase().padEnd(5)} ]`)
    )),
    h(Text, null, ''),
    h(Text, { dimColor: true }, `Current profile: ${PROFILES[detectProfile(policy)].label}`),
    h(Text, { dimColor: true }, 'Presets: A Auto · O Read-only · F Allow all'),
    h(Text, { dimColor: true }, `Additional roots: ${policy.additionalRoots.length} · Custom command rules: ${policy.commandRules.length}`)
  );
}

function RootsScreen({ root, roots, selected, inputMode, buffer }) {
  const all = [root, ...roots];
  return h(Box, { borderStyle: 'classic', paddingX: 1, flexDirection: 'column', flexGrow: 1 },
    title('ALLOWED ROOTS'),
    h(Text, { dimColor: true }, 'Primary root comes from this instance workspace. Additional roots belong only to this instance.'),
    h(Text, null, ''),
    ...all.map((value, index) => h(Text, { key: `${value}-${index}`, bold: index === selected, wrap: 'truncate-end' }, `${index === selected ? '›' : ' '} ${index === 0 ? '[PRIMARY] ' : '[ADDITIONAL] '}${value}`)),
    inputMode === 'root' ? h(Text, null, `\nNew root: ${buffer}█`) : null
  );
}

function CommandsScreen({ rules, selected, inputMode, buffer }) {
  return h(Box, { borderStyle: 'classic', paddingX: 1, flexDirection: 'column', flexGrow: 1 },
    title('COMMAND RULES'),
    h(Text, { dimColor: true }, 'Rules match an executable plus argument prefix. Commands do not run through a shell.'),
    h(Text, null, ''),
    rules.length === 0 ? h(Text, { dimColor: true }, 'No custom command rules.') : null,
    ...rules.map((rule, index) => h(Text, { key: `${rule.executable}-${index}`, bold: index === selected, wrap: 'truncate-end' },
      `${index === selected ? '›' : ' '} ${(rule.executable + ' ' + (rule.argsPrefix ?? []).join(' ')).trim().padEnd(28)} [ ${String(rule.action).toUpperCase()} ]`
    )),
    inputMode === 'command' ? h(Text, null, `\nNew rule: ${buffer}█`) : null
  );
}

function ToolsScreen({ manifest, manifestState, toolsUrl, auditPath }) {
  return h(Box, { borderStyle: 'classic', paddingX: 1, flexDirection: 'column', flexGrow: 1 },
    title('DIAGNOSTICS'),
    manifestState?.changed
      ? h(Text, { color: 'yellow', bold: true }, 'MCP tool definitions changed since the previous run. ChatGPT may need to refresh tool discovery.')
      : h(Text, { dimColor: true }, 'MCP tool definitions match the previous run.'),
    h(Text, null, ''),
    h(Text, { wrap: 'truncate-end' }, `Audit log     ${auditPath ?? '~/.buildifyx/audit.log'}`),
    h(Text, { wrap: 'truncate-end' }, `Tools source  ${toolsUrl ?? 'unavailable'}`),
    h(Text, null, `Tools         ${manifest?.count ?? 0}`),
    h(Text, { dimColor: true }, `Schema hash   ${manifest?.hash ?? 'unknown'}`),
    manifestState?.previousHash ? h(Text, { dimColor: true }, `Previous      ${manifestState.previousHash}`) : null,
    h(Text, null, ''),
    ...(manifest?.tools ?? []).map((tool) => h(Box, { key: tool.name, flexDirection: 'column', marginBottom: 1 },
      h(Text, { bold: true }, `✓ ${tool.name}`),
      h(Text, { dimColor: true }, `  ${tool.permission ?? 'unknown'} · ${tool.title}`)
    ))
  );
}

function BackgroundConfirmScreen({ instanceName, root }) {
  return h(Box, { borderStyle: 'classic', paddingX: 1, flexDirection: 'column', flexGrow: 1 },
    title('RUN IN BACKGROUND'),
    h(Text, null, ''),
    h(Text, null, 'Keep this workspace connected after returning to the shell?'),
    h(Text, null, ''),
    h(Text, null, `Instance   ${instanceName}`),
    h(Text, { wrap: 'truncate-end' }, `Workspace  ${root}`),
    h(Text, null, ''),
    h(Text, { dimColor: true }, 'The same instance ID and workspace settings will be preserved.'),
    h(Text, { dimColor: true }, 'Use `bdxa attach` to open this dashboard again.'),
    h(Text, null, ''),
    h(Text, { dimColor: true }, 'Enter Confirm   Q Back   Ctrl+C Stop')
  );
}

function HelpScreen({ attached = false, canBackground = false }) {
  const exitLabel = attached ? 'Detach dashboard' : 'Stop agent';
  return h(Box, { borderStyle: 'classic', paddingX: 1, flexDirection: 'column', flexGrow: 1 },
    title('HELP'),
    h(Text, { bold: true }, 'Main'),
    h(Text, null, '  ↑↓       Select recent activity'),
    h(Text, null, '  P        Permissions'),
    h(Text, null, '  ? / H    Help'),
    canBackground ? h(Text, null, '  D        Run this instance in background') : null,
    h(Text, null, '  Q        Back'),
    h(Text, null, `  Ctrl+C   ${exitLabel}`),
    h(Text, null, ''),
    h(Text, { bold: true }, 'Advanced'),
    h(Text, null, '  R        Allowed roots'),
    h(Text, null, '  C        Command rules'),
    h(Text, null, '  T        Diagnostics and MCP tools'),
    h(Text, null, ''),
    h(Text, { bold: true }, 'Approvals'),
    h(Text, null, '  ↑↓       Select decision'),
    h(Text, null, '  Enter    Confirm'),
    h(Text, null, '  Q        Back / deny request'),
    h(Text, null, `  Ctrl+C   ${exitLabel}`)
  );
}
async function applyProfile(policyManager, profileKey) {
  const profile = PROFILES[profileKey];
  if (!profile?.categories) return;
  for (const [category, action] of Object.entries(profile.categories)) await policyManager.setCategory(category, action);
}

export function App({ eventBus, approvalQueue, policyManager, version, updateStatus, root, instanceId, instanceName, mode, auditPath, toolManifest, toolManifestState, toolsUrl, onQuit, onBackground, attached = false }) {
  const { exit } = useApp();
  const layout = useTuiLayout({ hasUpdate: Boolean(updateStatus?.updateAvailable || updateStatus?.restartRequired) });
  const initialEvents = eventBus.getHistory();
  const initialConnectionStatus = [...initialEvents].reverse().find((event) => event.type === 'cloud.connection')?.status ?? 'connecting';
  const [events, setEvents] = useState(initialEvents);
  const [connectionStatus, setConnectionStatus] = useState(initialConnectionStatus);
  const [pending, setPending] = useState(approvalQueue.getPending());
  const [policy, setPolicy] = useState(policyManager.get());
  const [screen, setScreen] = useState('dashboard');
  const [activitySelected, setActivitySelected] = useState(() => Math.max(0, groupActivities(initialEvents).length - 1));
  const [permissionSelected, setPermissionSelected] = useState(0);
  const [rootSelected, setRootSelected] = useState(0);
  const [commandSelected, setCommandSelected] = useState(0);
  const [approvalSelected, setApprovalSelected] = useState(0);
  const [inputMode, setInputMode] = useState(null);
  const [buffer, setBuffer] = useState('');
  const [backgroundConfirm, setBackgroundConfirm] = useState(false);
  const initialMessage = toolManifestState?.changed
    ? 'MCP tools changed since the previous run. Press T for diagnostics.'
    : initialConnectionStatus === 'connected'
      ? 'Connected. Waiting for requests from ChatGPT...'
      : 'Connecting to Buildifyx Cloud...';
  const [message, setMessage] = useState(initialMessage);

  useEffect(() => eventBus.subscribe((event) => {
    setEvents(eventBus.getHistory());
    if (event.type === 'tool.started') { setMessage(`Running tool: ${event.tool}`); return; }
    if (event.type === 'tool.completed') { setMessage(`Completed tool: ${event.tool} · ${event.durationMs} ms`); return; }
    if (event.type === 'tool.failed') { setMessage(`Failed tool: ${event.tool} · ${event.error?.code ?? 'ERROR'}`); return; }
    if (event.type !== 'cloud.connection') return;
    setConnectionStatus(event.status);
    if (event.status === 'connected') setMessage('Connected. Waiting for requests from ChatGPT...');
    else if (event.status === 'reconnecting') setMessage(`Connection lost. Reconnecting${event.retryInMs ? ` in ${Math.ceil(event.retryInMs / 1000)}s` : ''}...`);
    else if (event.status === 'revoked') setMessage('Device access was revoked. This agent is shutting down.');
    else if (event.status === 'disconnected') setMessage('Disconnected from Buildifyx Cloud.');
    else if (event.status === 'connecting') setMessage('Connecting to Buildifyx Cloud...');
  }), [eventBus]);
  useEffect(() => approvalQueue.subscribe((next) => { setPending(next); if (next.length) setApprovalSelected(0); }), [approvalQueue]);
  useEffect(() => policyManager.subscribe((next) => setPolicy({ ...next, categories: { ...next.categories } })), [policyManager]);

  const activities = useMemo(() => groupActivities(events), [events]);
  const previousActivityCount = useRef(null);
  const profile = detectProfile(policy);
  const request = pending[0] ?? null;
  const approvalNeedsResize = Boolean(request && layout.panelHeight < 10);
  const interactionBlocked = layout.tooSmall || approvalNeedsResize;
  const selectedIndex = activities.length ? Math.min(activitySelected, activities.length - 1) : -1;
  const selectedItem = selectedIndex >= 0 ? activities[selectedIndex] : null;

  useEffect(() => {
    const previousCount = previousActivityCount.current;
    if (previousCount === null) {
      previousActivityCount.current = activities.length;
      return;
    }
    setActivitySelected((value) => {
      if (!activities.length) return 0;
      const wasFollowingNewest = previousCount === 0 || value >= previousCount - 1;
      if (activities.length > previousCount && wasFollowingNewest) return activities.length - 1;
      return Math.min(value, activities.length - 1);
    });
    previousActivityCount.current = activities.length;
  }, [activities.length]);

  async function quit() {
    await onQuit();
    exit();
  }

  useInput(async (input, key) => {
    if (key.ctrl && input.toLowerCase() === 'c') { await quit(); return; }
    if (interactionBlocked) return;
    if (request) {
      const choices = approvalChoices(request);
      if (input === 'q' || input === 'Q') {
        approvalQueue.resolve(request.id, { action: 'deny', remember: null });
        setMessage('Request denied.');
      } else if (key.upArrow) {
        setApprovalSelected((value) => Math.max(0, value - 1));
      } else if (key.downArrow) {
        setApprovalSelected((value) => Math.min(choices.length - 1, value + 1));
      } else if (key.return) {
        const choice = choices[Math.min(approvalSelected, choices.length - 1)];
        approvalQueue.resolve(request.id, { action: choice.action, remember: choice.remember });
        setMessage(choice.action === 'deny' ? 'Request denied.' : choice.remember ? `${choice.label}.` : 'Request allowed once.');
      }
      return;
    }

    if (backgroundConfirm) {
      if (input === 'q' || input === 'Q') {
        setBackgroundConfirm(false);
        setMessage('Background handoff cancelled.');
      } else if (key.return) {
        if (!onBackground) {
          setBackgroundConfirm(false);
          setMessage('Background mode is not available from this dashboard.');
          return;
        }
        setMessage('Moving this workspace to the background...');
        try {
          await onBackground();
          exit();
        } catch (error) {
          setBackgroundConfirm(false);
          setMessage(`Background handoff failed: ${error?.message ?? String(error)}`);
          if (error?.handoffFatal) {
            await onQuit();
            exit();
          }
        }
      }
      return;
    }

    if (inputMode) {
      if ((input === 'q' || input === 'Q') && buffer.length === 0) { setInputMode(null); setBuffer(''); setMessage('Edit cancelled.'); return; }
      if (key.return) {
        const value = buffer.trim();
        if (value && inputMode === 'root') { await policyManager.addRoot(value); setMessage(`Added root: ${value}`); }
        if (value && inputMode === 'command') {
          const [executable, ...argsPrefix] = value.split(/\s+/);
          await policyManager.addCommandRule({ executable, argsPrefix, action: 'ask' });
          setMessage(`Added command rule: ${value} → ASK`);
        }
        setInputMode(null);
        setBuffer('');
        return;
      }
      if (key.backspace || key.delete) { setBuffer((value) => value.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setBuffer((value) => value + input);
      return;
    }

    if (input === 'q' || input === 'Q') {
      if (screen !== 'dashboard') { setScreen('dashboard'); setMessage('Back to dashboard.'); }
      else setMessage(attached ? 'Ctrl+C detaches this dashboard.' : 'Ctrl+C stops the agent.');
      return;
    }

    if (screen === 'dashboard') {
      if (key.upArrow) setActivitySelected((value) => Math.max(0, value - 1));
      else if (key.downArrow) setActivitySelected((value) => Math.min(Math.max(activities.length - 1, 0), value + 1));
      else if (input === 'p' || input === 'P') setScreen('permissions');
      else if (input === 'r' || input === 'R') setScreen('roots');
      else if (input === 'c' || input === 'C') setScreen('commands');
      else if (input === 't' || input === 'T') setScreen('tools');
      else if ((input === 'd' || input === 'D') && !attached && onBackground) {
        setBackgroundConfirm(true);
        setMessage('Confirm moving this workspace to the background.');
      } else if (input === '?' || input === 'h' || input === 'H') setScreen('help');
      return;
    }

    if (screen === 'permissions') {
      if (key.upArrow) setPermissionSelected((value) => Math.max(0, value - 1));
      else if (key.downArrow) setPermissionSelected((value) => Math.min(CATEGORIES.length - 1, value + 1));
      else if (key.leftArrow) {
        const category = CATEGORIES[permissionSelected];
        await policyManager.setCategory(category, cycleAction(policy.categories[category], -1));
      } else if (key.rightArrow || input === ' ') {
        const category = CATEGORIES[permissionSelected];
        await policyManager.setCategory(category, cycleAction(policy.categories[category], 1));
      } else if (input === 'a' || input === 'A') await applyProfile(policyManager, 'auto');
      else if (input === 'o' || input === 'O') await applyProfile(policyManager, 'readOnly');
      else if (input === 'f' || input === 'F') await applyProfile(policyManager, 'fullAccess');
      else if (input === 'r' || input === 'R') setScreen('roots');
      else if (input === 'c' || input === 'C') setScreen('commands');
      return;
    }

    if (screen === 'roots') {
      const total = policy.additionalRoots.length + 1;
      if (key.upArrow) setRootSelected((value) => Math.max(0, value - 1));
      else if (key.downArrow) setRootSelected((value) => Math.min(total - 1, value + 1));
      else if (input === 'a' || input === 'A') { setInputMode('root'); setBuffer(''); }
      else if ((input === 'd' || input === 'D') && rootSelected > 0) {
        await policyManager.removeRoot(rootSelected - 1);
        setRootSelected((value) => Math.max(0, value - 1));
        setMessage('Allowed root removed.');
      }
      return;
    }

    if (screen === 'commands') {
      const total = policy.commandRules.length;
      if (key.upArrow) setCommandSelected((value) => Math.max(0, value - 1));
      else if (key.downArrow) setCommandSelected((value) => Math.min(Math.max(total - 1, 0), value + 1));
      else if ((key.leftArrow || key.rightArrow || input === ' ') && total) {
        const rule = policy.commandRules[commandSelected];
        await policyManager.addCommandRule({ ...rule, action: cycleAction(rule.action, key.leftArrow ? -1 : 1) });
      } else if (input === 'a' || input === 'A') {
        setInputMode('command');
        setBuffer('');
      } else if ((input === 'd' || input === 'D') && total) {
        await policyManager.removeCommandRule(commandSelected);
        setCommandSelected((value) => Math.max(0, value - 1));
        setMessage('Command rule removed.');
      }
    }
  });

  const canBackground = !attached && typeof onBackground === 'function';
  if (interactionBlocked) {
    const lines = [
      `Buildifyx Desktop Agent v${version}`,
      `Status     ${String(connectionStatus).toUpperCase()}`,
      `Instance   ${instanceName}`,
      request ? 'Approval   Pending · resize to review before responding' : null,
      updateStatus?.restartRequired
        ? `Restart    running v${updateStatus.runningVersion ?? version} · installed v${updateStatus.installedVersion ?? version} · bdxa restart ${String(instanceId ?? instanceName).replace(/^inst_/, '').slice(0, 8)}`
        : updateStatus?.updateAvailable && updateStatus.latestVersion
          ? `Update     v${version} → v${updateStatus.latestVersion} · bdxa update`
          : null,
      `Terminal   ${layout.columns}x${layout.rows} is too small. Resize to continue.`,
      message
    ].filter(Boolean).slice(0, layout.canvasRows);
    return h(Box, { flexDirection: 'column', width: '100%', height: layout.canvasRows },
      ...lines.map((line, index) => h(Text, { key: `${index}-${line}`, wrap: 'truncate-end' }, line))
    );
  }
  let main;
  if (backgroundConfirm) main = h(BackgroundConfirmScreen, { instanceName, root });
  else if (screen === 'permissions') main = h(PermissionsScreen, { policy, selected: permissionSelected });
  else if (screen === 'roots') main = h(RootsScreen, { root, roots: policy.additionalRoots, selected: rootSelected, inputMode, buffer });
  else if (screen === 'commands') main = h(CommandsScreen, { rules: policy.commandRules, selected: commandSelected, inputMode, buffer });
  else if (screen === 'tools') main = h(ToolsScreen, { manifest: toolManifest, manifestState: toolManifestState, toolsUrl, auditPath });
  else if (screen === 'help') main = h(HelpScreen, { attached, canBackground });
  else main = h(Box, { flexDirection: layout.narrow ? 'column' : 'row' },
    h(ActivityPanel, { activities, selected: selectedIndex, layout }),
    h(StatusPanel, { selectedItem, request, approvalSelected, layout, attached })
  );

  return h(Box, { flexDirection: 'column', width: '100%', height: layout.canvasRows },
    h(Header, { version, updateStatus, root, instanceId, instanceName, mode, profile, pendingCount: pending.length, connectionStatus }),
    main,
    h(Controls, { screen, inputMode, compact: layout.compact, attached, canBackground, backgroundConfirm }),
    h(Text, { color: message.startsWith('MCP tools changed') ? 'yellow' : 'cyan', wrap: 'truncate-end' }, message)
  );
}