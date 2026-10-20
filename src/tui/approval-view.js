// Never render untrusted command/path text as terminal control sequences or
// additional rows. A pending approval may carry paths and arguments supplied
// by an external MCP request.
export function safeApprovalText(value, maxLength = 180) {
  const text = String(value ?? '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim();
  return text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text;
}

export function visibleTuiScreen(screen, request, backgroundConfirm) {
  if (request) return 'approval';
  if (backgroundConfirm) return 'background-confirm';
  return screen;
}

// TUI-only approval presentation; never elevates a stored permission.
// Persistent profiles and sensitive browser actions are once-only by default.
export function approvalChoices(request) {
  const choices = [{ label: 'Allow once', action: 'allow', remember: null }];
  if (request?.category === 'outsideRoot' && request?.pathInfo?.scope === 'outside') {
    choices.push({ label: 'Always allow this location', action: 'allow', remember: 'root' });
  } else if (request?.toolName === 'run_command' && request?.category !== 'browserSensitive') {
    choices.push({ label: 'Remember exact command here', action: 'allow', remember: 'command' });
  }
  choices.push({ label: 'Deny', action: 'deny', remember: null });
  return choices;
}

export function defaultApprovalSelection(request) {
  return approvalChoices(request).length - 1; // fail closed; Enter never defaults to Allow
}

export function approvalCategoryLabel(request) {
  if (request?.category === 'outsideRoot') return 'Outside workspace';
  if (request?.toolName === 'run_command') {
    const label = {
      'dependency-install': 'Install dependencies',
      'code-execution': 'Run project code',
      'repository-change': 'Git changes / helpers',
      'destructive': 'Delete data / control processes',
      'unclassified': 'Review host command',
      'workspace-read': 'Read workspace',
      'developer-query': 'Developer query'
    }[request.evaluation?.operationClass];
    if (label) return label;
  }
  return request?.category ?? 'permission';
}

export function approvalImpact(request) {
  if (request?.toolName === 'run_command' && request?.category !== 'outsideRoot'
    && request?.evaluation?.operationClass) return request.evaluation.reason;
  if (request?.category === 'browserSensitive') return 'Sensitive browser action: explicitly approve this request only.';
  if (request?.category === 'persistentProfile') return 'Persistent browser profile: never remember this approval automatically.';
  if (request?.category === 'browserExternal') return 'Access to a website outside localhost requires approval.';
  if (request?.category === 'dangerous') return 'Dangerous action: may make significant changes.';
  if (request?.pathInfo?.scope === 'outside') return 'Access outside the current workspace.';
  if (request?.category === 'write' || request?.category === 'imageSave') return 'This action can modify or save files.';
  if (request?.category === 'command') return 'This action runs a command on this computer.';
  return request?.evaluation?.reason ?? request?.category ?? 'Approval required.';
}

export function activeApproval(pending) {
  return Array.isArray(pending) && pending.length ? pending[0] : null;
}

export function approvalVisibleRows(availableRows) {
  // Include the box border, title, context, at most three decisions and a
  // footer; compact for 10-14 rows. Below 10, fail closed with resize prompt.
  return { canRespond: availableRows >= 10, compact: availableRows < 15 };
}
