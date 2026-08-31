import { Decision } from './policy.js';

const TOOL_CATEGORY = Object.freeze({
  get_system_info: 'read',
  list_directory: 'read',
  read_file: 'read',
  write_file: 'write',
  edit_file: 'write',
  run_command: 'command'
});

const FILE_TOOLS = new Set(['list_directory', 'read_file', 'write_file', 'edit_file']);
const DANGEROUS_COMMANDS = new Set(['rm', 'rmdir', 'del', 'erase', 'format', 'shutdown', 'reboot', 'kill', 'taskkill']);

function startsWithArgs(args, prefix = []) {
  return prefix.every((value, index) => args[index] === value);
}

export function matchCommandRule(policy, command, args = []) {
  const matches = policy.commandRules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.executable === command && startsWithArgs(args, rule.argsPrefix ?? []));

  if (!matches.length) return undefined;

  // Prefer the most specific argument-prefix rule. If two rules are equally
  // specific, prefer the latest one so a newer user choice wins predictably.
  matches.sort((left, right) => {
    const specificity = (right.rule.argsPrefix?.length ?? 0) - (left.rule.argsPrefix?.length ?? 0);
    return specificity !== 0 ? specificity : right.index - left.index;
  });

  return matches[0].rule;
}

export function isDangerousCommand(command, args = []) {
  if (DANGEROUS_COMMANDS.has(command)) return true;
  if (command === 'git' && ['clean', 'reset'].includes(args[0])) return true;
  if (['npm', 'pnpm', 'yarn'].includes(command) && ['uninstall', 'remove'].includes(args[0])) return true;
  return false;
}

export function getRequestedPath(toolName, input = {}) {
  if (FILE_TOOLS.has(toolName) && typeof input.path === 'string') return input.path;
  if (toolName === 'run_command' && typeof input.cwd === 'string') return input.cwd;
  return null;
}

export function isFullAccessPolicy(policy) {
  return ['read', 'write', 'command', 'dangerous', 'outsideRoot']
    .every((category) => policy.categories[category] === Decision.ALLOW);
}

export function evaluateRequest({ toolName, input = {}, policy, pathScope = 'root' }) {
  const category = TOOL_CATEGORY[toolName];
  if (!category) return { decision: Decision.DENY, category: 'unknown', reason: 'Unknown tool' };

  if (pathScope === 'outside') {
    return {
      decision: policy.categories.outsideRoot ?? Decision.DENY,
      category: 'outsideRoot',
      reason: 'Path is outside configured roots'
    };
  }

  if (toolName === 'run_command') {
    const args = input.args ?? [];
    const rule = matchCommandRule(policy, input.command, args);
    if (rule) {
      const pattern = [rule.executable, ...(rule.argsPrefix ?? [])].join(' ');
      return { decision: rule.action, category: 'commandRule', rule, reason: `Matched command rule: ${pattern}` };
    }
    if (isDangerousCommand(input.command, args)) {
      return {
        decision: policy.categories.dangerous ?? Decision.ASK,
        category: 'dangerous',
        reason: 'Command is potentially destructive'
      };
    }
  }

  return {
    decision: policy.categories[category] ?? Decision.DENY,
    category,
    reason: `Policy category: ${category}`
  };
}

export function describeRequest(toolName, input = {}) {
  if (toolName === 'run_command') return `${input.command ?? ''} ${(input.args ?? []).join(' ')}`.trim();
  if (typeof input.path === 'string') return `${toolName}: ${input.path}`;
  return toolName;
}
