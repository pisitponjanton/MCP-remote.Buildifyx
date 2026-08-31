import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { detectProfile, PROFILES } from './profiles.js';
import { groupActivities, shortTime, statusColor, statusGlyph } from './model.js';
import { useTuiLayout } from './layout.js';

const h = React.createElement;
const ACTIONS = ['allow', 'ask', 'deny'];
const CATEGORIES = ['read', 'write', 'command', 'dangerous', 'outsideRoot'];

function cycleAction(current, direction) {
  const index = ACTIONS.indexOf(current);
  return ACTIONS[(index + direction + ACTIONS.length) % ACTIONS.length];
}

function title(text) {
  return h(Text, { bold: true }, text);
}

function Header({ version, root, mode, profile, pendingCount, layout, toolManifest, toolsChanged }) {
  const toolLabel = toolManifest ? `Tools ${toolManifest.count} · ${toolManifest.shortHash}` : 'Tools ?';
  const toolState = toolsChanged ? ' · TOOLS CHANGED' : '';

  if (layout.narrow) {
    return h(Box, { flexDirection: 'column', marginBottom: 1 },
      h(Box, { justifyContent: 'space-between' },
        h(Text, { bold: true }, `BuildifyX Desktop Agent v${version}`),
        h(Text, { bold: true }, pendingCount ? `● WAITING ${pendingCount}` : '● ONLINE')
      ),
      h(Text, { wrap: 'truncate-end' }, `Root ${root}`),
      h(Text, null, `${mode} · ${PROFILES[profile].label} · ${toolLabel}${toolState}`)
    );
  }

  return h(Box, { flexDirection: 'column', marginBottom: 1 },
    h(Box, { justifyContent: 'space-between' },
      h(Text, { bold: true }, `BuildifyX Desktop Agent  v${version}`),
      h(Text, { bold: true }, pendingCount ? `MCP ● WAITING (${pendingCount})` : 'MCP ● ONLINE')
    ),
    h(Box, { justifyContent: 'space-between' },
      h(Text, { wrap: 'truncate-end' }, `Root ${root}`),
      h(Text, null, `Mode ${mode}   Permissions ${PROFILES[profile].label}`)
    ),
    h(Text, { color: toolsChanged ? 'yellow' : undefined }, `${toolLabel}${toolState}`)
  );
}

function ActivityPanel({ activities, selected, layout }) {
  const windowSize = layout.activityWindow;
  const half = Math.floor(windowSize / 2);
  const start = Math.max(0, Math.min(Math.max(0, activities.length - windowSize), selected - half));
  const visible = activities.slice(start, start + windowSize);

  return h(Box, { width: layout.activityWidth, borderStyle: 'classic', paddingX: 1, flexDirection: 'column', height: layout.panelHeight },
    title(`ACTIVITY  ${activities.length}`),
    visible.length === 0
      ? h(Text, { dimColor: true }, 'Waiting for MCP tool calls...')
      : visible.map((item, localIndex) => {
          const actualIndex = start + localIndex;
          const active = actualIndex === selected;
          return h(Box, { key: item.requestId, flexDirection: 'column', marginBottom: layout.compact ? 0 : 1 },
            h(Box, null,
              h(Text, { bold: active }, active ? '› ' : '  '),
              h(Text, { dimColor: !active }, `${shortTime(item.started.timestamp)} `),
              h(Text, { color: statusColor(item.status), bold: active }, `${statusGlyph(item.status)} `),
              h(Text, { bold: active }, item.started.tool)
            ),
            item.summary ? h(Text, { dimColor: !active, wrap: 'truncate-end' }, `    ${item.summary}`) : null
          );
        })
  );
}

function RequestDetails({ item, compact }) {
  if (!item) return h(Text, { dimColor: true }, 'No request selected.');
  const resourceLimit = compact ? 3 : 7;
  const resources = item.resources.slice(-resourceLimit);

  return h(Box, { flexDirection: 'column' },
    h(Text, null, `Tool:       ${item.started.tool}`),
    item.summary ? h(Text, { wrap: 'truncate-end' }, `Request:    ${item.summary}`) : null,
    h(Text, null, `Status:     ${item.status.toUpperCase()}`),
    item.permission ? h(Text, null, `Permission: ${item.permission.category} → ${item.permission.decision}`) : null,
    item.process ? h(Text, { wrap: 'truncate-end' }, `Command:    ${item.process.command} ${(item.process.args ?? []).join(' ')}`) : null,
    item.process ? h(Text, { wrap: 'truncate-end' }, `Cwd:        ${item.process.cwd}`) : null,
    ...resources.map((resource) => h(Text, { key: resource.id, wrap: 'truncate-end' }, `${String(resource.operation).toUpperCase().padEnd(11)} ${resource.path}`)),
    item.resources.length > resources.length ? h(Text, { dimColor: true }, `… ${item.resources.length - resources.length} more resources`) : null,
    item.completed ? h(Text, null, `Duration:   ${item.completed.durationMs} ms`) : null,
    item.failed ? h(Text, null, `Error:      ${item.failed.error?.code ?? 'ERROR'}`) : null,
    item.failed && !compact ? h(Text, { wrap: 'wrap' }, `            ${item.failed.error?.message ?? 'Request failed'}`) : null
  );
}

function ApprovalPanel({ request, selected }) {
  const choices = ['Allow once', 'Always allow this request', 'Deny'];
  return h(Box, { flexDirection: 'column' },
    h(Text, { bold: true }, 'APPROVAL REQUIRED'),
    h(Text, null, ''),
    h(Text, { wrap: 'wrap' }, request.description),
    request.pathInfo ? h(Text, { wrap: 'truncate-end' }, `Path: ${request.pathInfo.resolved}`) : null,
    h(Text, { dimColor: true, wrap: 'wrap' }, request.evaluation?.reason ?? request.category),
    h(Text, null, ''),
    ...choices.map((choice, index) => h(Text, { key: choice, bold: selected === index }, `${selected === index ? '›' : ' '} ${choice}`)),
    h(Text, null, ''),
    h(Text, { dimColor: true }, '↑↓ Select   Enter Confirm   Q Back/Deny')
  );
}

function StatusPanel({ selectedItem, request, approvalSelected, layout }) {
  return h(Box, { width: layout.statusWidth, borderStyle: 'classic', paddingX: 1, flexDirection: 'column', height: layout.panelHeight },
    request
      ? h(ApprovalPanel, { request, selected: approvalSelected })
      : h(React.Fragment, null, title('STATUS'), h(RequestDetails, { item: selectedItem, compact: layout.compact }))
  );
}

function PermissionsSummary({ policy, profile, compact, toolManifest, toolsChanged }) {
  const category = policy.categories;
  const toolText = toolManifest ? `Tools ${toolManifest.count} · ${toolManifest.shortHash}${toolsChanged ? ' · CHANGED' : ''}` : 'Tools unavailable';
  const lines = compact
    ? [
        `Profile ${PROFILES[profile].label} · Read ${String(category.read).toUpperCase()} · Write ${String(category.write).toUpperCase()} · Outside ${String(category.outsideRoot).toUpperCase()}`,
        `Command ${String(category.command).toUpperCase()} · Dangerous ${String(category.dangerous).toUpperCase()} · ${toolText}`
      ]
    : [
        `Profile ${PROFILES[profile].label}`,
        `Files  Read ${String(category.read).toUpperCase()}  Write ${String(category.write).toUpperCase()}  Outside ${String(category.outsideRoot).toUpperCase()}`,
        `Commands  Normal ${String(category.command).toUpperCase()}  Dangerous ${String(category.dangerous).toUpperCase()}  Custom ${policy.commandRules.length}`,
        `Roots  primary + ${policy.additionalRoots.length} additional   ${toolText}`
      ];

  return h(Box, { borderStyle: 'classic', paddingX: 1, flexDirection: 'column' },
    title('PERMISSIONS / MCP'),
    ...lines.map((line) => h(Text, { key: line, wrap: 'truncate-end', color: toolsChanged && line.includes('Tools') ? 'yellow' : undefined }, line))
  );
}

function Controls({ screen, inputMode, compact }) {
  let lines;
  if (inputMode) lines = ['Enter: Save   Q on empty input: Back'];
  else if (screen === 'permissions') lines = ['↑↓ Select   ←→ Change   A Auto   O Read-only   F Full   Q Back'];
  else if (screen === 'roots') lines = ['↑↓ Select   A Add root   D Delete root   Q Back'];
  else if (screen === 'commands') lines = ['↑↓ Select   ←→ Change   A Add rule   D Delete rule   Q Back'];
  else if (screen === 'tools') lines = ['Q: Back   Ctrl+C: Quit'];
  else if (screen === 'help') lines = ['Q: Back   Ctrl+C: Quit'];
  else lines = compact
    ? ['↑↓ Activity  P Permissions  R Roots  C Commands  T Tools  ?: Help  Ctrl+C Quit']
    : ['↑↓ Activity   P: Permissions   R: Roots   C: Commands   T: MCP Tools', 'L: Audit info   ?: Help   Q: Back   Ctrl+C: Quit'];

  return h(Box, { borderStyle: 'classic', paddingX: 1, flexDirection: 'column' },
    title('CONTROLS'),
    ...lines.map((line) => h(Text, { key: line, wrap: 'truncate-end' }, line))
  );
}

function PermissionsScreen({ policy, selected }) {
  return h(Box, { borderStyle: 'classic', paddingX: 1, flexDirection: 'column', flexGrow: 1 },
    title('PERMISSIONS'),
    h(Text, { dimColor: true }, 'Change how ChatGPT can operate this machine.'),
    h(Text, null, ''),
    ...CATEGORIES.map((category, index) => h(Box, { key: category },
      h(Text, { bold: index === selected }, `${index === selected ? '›' : ' '} ${category.padEnd(16)}`),
      h(Text, { bold: index === selected }, `[ ${String(policy.categories[category]).toUpperCase().padEnd(5)} ]`)
    )),
    h(Text, null, ''),
    h(Text, null, `Additional roots: ${policy.additionalRoots.length}`),
    h(Text, null, `Custom command rules: ${policy.commandRules.length}`)
  );
}

function RootsScreen({ root, roots, selected, inputMode, buffer }) {
  const all = [root, ...roots];
  return h(Box, { borderStyle: 'classic', paddingX: 1, flexDirection: 'column', flexGrow: 1 },
    title('ALLOWED ROOTS'),
    h(Text, { dimColor: true }, 'ChatGPT file tools may access these locations.'),
    h(Text, null, ''),
    ...all.map((value, index) => h(Text, { key: `${value}-${index}`, bold: index === selected, wrap: 'truncate-end' }, `${index === selected ? '›' : ' '} ${index === 0 ? '[PRIMARY] ' : ''}${value}`)),
    inputMode === 'root' ? h(Text, null, `\nNew root: ${buffer}█`) : null
  );
}

function CommandsScreen({ rules, selected, inputMode, buffer }) {
  return h(Box, { borderStyle: 'classic', paddingX: 1, flexDirection: 'column', flexGrow: 1 },
    title('CUSTOM COMMAND RULES'),
    h(Text, { dimColor: true }, 'Rules match executable + argument prefix. No shell strings.'),
    h(Text, null, ''),
    rules.length === 0 ? h(Text, { dimColor: true }, 'No custom command rules.') : null,
    ...rules.map((rule, index) => h(Text, { key: `${rule.executable}-${index}`, bold: index === selected, wrap: 'truncate-end' },
      `${index === selected ? '›' : ' '} ${(rule.executable + ' ' + (rule.argsPrefix ?? []).join(' ')).trim().padEnd(28)} [ ${String(rule.action).toUpperCase()} ]`
    )),
    inputMode === 'command' ? h(Text, null, `\nNew rule: ${buffer}█`) : null
  );
}

function ToolsScreen({ manifest, manifestState, toolsUrl }) {
  return h(Box, { borderStyle: 'classic', paddingX: 1, flexDirection: 'column', flexGrow: 1 },
    title('MCP TOOLS'),
    manifestState?.changed
      ? h(Text, { color: 'yellow', bold: true }, 'Tool definitions changed since the previous bdxa run. ChatGPT may need to refresh tool discovery.')
      : h(Text, { color: 'green' }, 'Tool definitions match the previous bdxa run.'),
    h(Text, null, ''),
    h(Text, null, `Registered:   ${manifest?.count ?? 0}`),
    h(Text, null, `Schema hash:  ${manifest?.hash ?? 'unknown'}`),
    manifestState?.previousHash ? h(Text, { dimColor: true }, `Previous:     ${manifestState.previousHash}`) : null,
    h(Text, { wrap: 'truncate-end' }, `Manifest URL: ${toolsUrl ?? 'unavailable'}`),
    h(Text, null, ''),
    ...(manifest?.tools ?? []).map((tool) => h(Box, { key: tool.name, flexDirection: 'column', marginBottom: 1 },
      h(Text, { bold: true }, `✓ ${tool.name}`),
      h(Text, { dimColor: true }, `  ${tool.permission ?? 'unknown'} · ${tool.title}`)
    )),
    h(Text, { dimColor: true }, 'This shows what bdxa currently serves. It cannot directly inspect ChatGPT\'s cached tool snapshot.')
  );
}

function HelpScreen() {
  return h(Box, { borderStyle: 'classic', paddingX: 1, flexDirection: 'column', flexGrow: 1 },
    title('HELP'),
    h(Text, null, '  ↑↓       Select MCP activity'),
    h(Text, null, '  P        Edit permissions'),
    h(Text, null, '  R        Manage allowed roots'),
    h(Text, null, '  C        Manage custom command rules'),
    h(Text, null, '  T        Inspect MCP tools and schema hash'),
    h(Text, null, '  L        Show audit log path'),
    h(Text, null, '  Q        Back'),
    h(Text, null, '  Ctrl+C   Quit'),
    h(Text, null, ''),
    h(Text, null, 'APPROVALS'),
    h(Text, null, '  ↑↓       Select decision'),
    h(Text, null, '  Enter    Confirm'),
    h(Text, null, '  Q        Back / deny request')
  );
}

async function applyProfile(policyManager, profileKey) {
  const profile = PROFILES[profileKey];
  if (!profile?.categories) return;
  for (const [category, action] of Object.entries(profile.categories)) await policyManager.setCategory(category, action);
}

export function App({ eventBus, approvalQueue, policyManager, version, root, mode, auditPath, toolManifest, toolManifestState, toolsUrl, onQuit }) {
  const { exit } = useApp();
  const layout = useTuiLayout();
  const [events, setEvents] = useState(eventBus.getHistory());
  const [pending, setPending] = useState(approvalQueue.getPending());
  const [policy, setPolicy] = useState(policyManager.get());
  const [screen, setScreen] = useState('dashboard');
  const [activitySelected, setActivitySelected] = useState(0);
  const [permissionSelected, setPermissionSelected] = useState(0);
  const [rootSelected, setRootSelected] = useState(0);
  const [commandSelected, setCommandSelected] = useState(0);
  const [approvalSelected, setApprovalSelected] = useState(0);
  const [inputMode, setInputMode] = useState(null);
  const [buffer, setBuffer] = useState('');
  const initialMessage = toolManifestState?.changed
    ? `TOOLS CHANGED: ${toolManifest?.count ?? '?'} registered (${toolManifest?.shortHash ?? 'unknown'}). Press T to inspect; ChatGPT may need refresh.`
    : 'Waiting for MCP requests...';
  const [message, setMessage] = useState(initialMessage);

  useEffect(() => eventBus.subscribe(() => setEvents(eventBus.getHistory())), [eventBus]);
  useEffect(() => approvalQueue.subscribe((next) => { setPending(next); if (next.length) setApprovalSelected(0); }), [approvalQueue]);
  useEffect(() => policyManager.subscribe((next) => setPolicy({ ...next, categories: { ...next.categories } })), [policyManager]);

  const activities = useMemo(() => groupActivities(events), [events]);
  const profile = detectProfile(policy);
  const request = pending[0] ?? null;
  const selectedIndex = activities.length ? Math.min(activitySelected, activities.length - 1) : -1;
  const selectedItem = selectedIndex >= 0 ? activities[selectedIndex] : null;

  useEffect(() => {
    if (activities.length && activitySelected === 0) setActivitySelected(activities.length - 1);
  }, [activities.length]);

  async function quit() {
    await onQuit();
    exit();
  }

  useInput(async (input, key) => {
    if (key.ctrl && input.toLowerCase() === 'c') { await quit(); return; }

    if (request) {
      if (input === 'q' || input === 'Q') {
        approvalQueue.resolve(request.id, { action: 'deny', remember: null });
        setMessage('Permission request denied.');
      } else if (key.upArrow) setApprovalSelected((value) => Math.max(0, value - 1));
      else if (key.downArrow) setApprovalSelected((value) => Math.min(2, value + 1));
      else if (key.return) {
        if (approvalSelected === 0) approvalQueue.resolve(request.id, { action: 'allow', remember: null });
        else if (approvalSelected === 1) approvalQueue.resolve(request.id, { action: 'allow', remember: request.toolName === 'run_command' ? 'command' : request.pathInfo?.scope === 'outside' ? 'root' : null });
        else approvalQueue.resolve(request.id, { action: 'deny', remember: null });
      }
      return;
    }

    if (inputMode) {
      if ((input === 'q' || input === 'Q') && buffer.length === 0) { setInputMode(null); setBuffer(''); return; }
      if (key.return) {
        const value = buffer.trim();
        if (value && inputMode === 'root') { await policyManager.addRoot(value); setMessage(`Added root: ${value}`); }
        if (value && inputMode === 'command') {
          const [executable, ...argsPrefix] = value.split(/\s+/);
          await policyManager.addCommandRule({ executable, argsPrefix, action: 'ask' });
          setMessage(`Added command rule: ${value} → ASK`);
        }
        setInputMode(null); setBuffer(''); return;
      }
      if (key.backspace || key.delete) { setBuffer((value) => value.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) setBuffer((value) => value + input);
      return;
    }

    if (input === 'q' || input === 'Q') {
      if (screen !== 'dashboard') { setScreen('dashboard'); setMessage('Back to dashboard.'); }
      else setMessage('Ctrl+C quits the agent.');
      return;
    }

    if (screen === 'dashboard') {
      if (key.upArrow) setActivitySelected((value) => Math.max(0, value - 1));
      else if (key.downArrow) setActivitySelected((value) => Math.min(Math.max(activities.length - 1, 0), value + 1));
      else if (input === 'p' || input === 'P') setScreen('permissions');
      else if (input === 'r' || input === 'R') setScreen('roots');
      else if (input === 'c' || input === 'C') setScreen('commands');
      else if (input === 't' || input === 'T') setScreen('tools');
      else if (input === '?' || input === 'h' || input === 'H') setScreen('help');
      else if (input === 'l' || input === 'L') setMessage(`Audit log: ${auditPath ?? '~/.buildifyx/audit.log'}`);
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
      } else if (input === 'a' || input === 'A') { setInputMode('command'); setBuffer(''); }
      else if ((input === 'd' || input === 'D') && total) {
        await policyManager.removeCommandRule(commandSelected);
        setCommandSelected((value) => Math.max(0, value - 1));
      }
    }
  });

  let main;
  if (screen === 'permissions') main = h(PermissionsScreen, { policy, selected: permissionSelected });
  else if (screen === 'roots') main = h(RootsScreen, { root, roots: policy.additionalRoots, selected: rootSelected, inputMode, buffer });
  else if (screen === 'commands') main = h(CommandsScreen, { rules: policy.commandRules, selected: commandSelected, inputMode, buffer });
  else if (screen === 'tools') main = h(ToolsScreen, { manifest: toolManifest, manifestState: toolManifestState, toolsUrl });
  else if (screen === 'help') main = h(HelpScreen);
  else main = h(Box, { flexDirection: layout.narrow ? 'column' : 'row' },
    h(ActivityPanel, { activities, selected: selectedIndex, layout }),
    h(StatusPanel, { selectedItem, request, approvalSelected, layout })
  );

  return h(Box, { flexDirection: 'column', width: '100%', height: Math.max(16, layout.rows - 1) },
    h(Header, { version, root, mode, profile, pendingCount: pending.length, layout, toolManifest, toolsChanged: toolManifestState?.changed }),
    main,
    screen === 'dashboard' && layout.showPermissionsSummary
      ? h(PermissionsSummary, { policy, profile, compact: layout.compact, toolManifest, toolsChanged: toolManifestState?.changed })
      : null,
    h(Controls, { screen, inputMode, compact: layout.compact }),
    h(Text, { color: toolManifestState?.changed ? 'yellow' : 'cyan', wrap: 'truncate-end' }, message)
  );
}
