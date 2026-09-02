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
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn']);
const SAFE_PACKAGE_MANAGER_COMMANDS = new Set(['view', 'info', 'show', 'search', 'outdated', 'list', 'ls', 'why', 'help', '--version', '-v']);
const SAFE_GIT_COMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'grep', 'describe', 'blame', 'shortlog', 'merge-base', 'name-rev', 'cat-file', 'for-each-ref']);
const DANGEROUS_GIT_OPTIONS = new Set([
  '--ext-diff',
  '--textconv',
  '--filters',
  '--no-index',
  '--open-files-in-pager',
  '--output',
  '--paginate',
  '--exec-path',
  '--config-env'
]);
const DANGEROUS_GIT_OPTION_PREFIXES = [
  '--open-files-in-pager=',
  '--output=',
  '--exec-path=',
  '--config-env='
];

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

function packageManagerNeedsApproval(command, args) {
  if (!PACKAGE_MANAGERS.has(command)) return false;
  const subcommand = args[0] ?? '';
  if (!subcommand) return command !== 'npm';
  if (SAFE_PACKAGE_MANAGER_COMMANDS.has(subcommand)) return false;
  if (subcommand === 'config') {
    return !(command === 'npm' && args.length === 3 && args[1] === 'get' && args[2] === 'registry');
  }
  if (subcommand === 'audit') return args[1] === 'fix';
  return true;
}

function hasDangerousGitOption(args) {
  return args.some((arg) => {
    if (DANGEROUS_GIT_OPTIONS.has(arg)) return true;
    return DANGEROUS_GIT_OPTION_PREFIXES.some((prefix) => arg.startsWith(prefix));
  });
}

function gitNeedsApproval(args) {
  const subcommand = args[0] ?? '';
  if (!subcommand || hasDangerousGitOption(args)) return true;
  if (!SAFE_GIT_COMMANDS.has(subcommand)) {
    if (subcommand === 'branch') {
      return !args.slice(1).every((arg) => ['--show-current', '--list', '-l', '-a', '-r', '-v', '-vv', '--merged', '--no-merged'].includes(arg) || arg.startsWith('--format='));
    }
    if (subcommand === 'remote') return !(!args[1] || args[1] === '-v' || args[1] === 'get-url');
    if (subcommand === 'tag') return !(args.length === 1 || ['--list', '-l'].includes(args[1]));
    return true;
  }
  return false;
}

export function isDangerousCommand(command, args = []) {
  if (DANGEROUS_COMMANDS.has(command)) return true;
  if (command === 'git' && gitNeedsApproval(args)) return true;
  if (packageManagerNeedsApproval(command, args)) return true;
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

export function evaluateOutsideRoot(policy) {
  return {
    decision: policy.categories.outsideRoot ?? Decision.DENY,
    category: 'outsideRoot',
    reason: 'Path is outside configured roots'
  };
}

export function evaluateRequest({ toolName, input = {}, policy }) {
  const category = TOOL_CATEGORY[toolName];
  if (!category) return { decision: Decision.DENY, category: 'unknown', reason: 'Unknown tool' };

  if (toolName === 'run_command') {
    const args = input.args ?? [];
    const rule = matchCommandRule(policy, input.command, args);
    const dangerous = isDangerousCommand(input.command, args);
    const exactAllowRule = rule?.action === Decision.ALLOW
      && (rule.argsPrefix?.length ?? 0) === args.length;
    if (rule && (!dangerous || rule.action !== Decision.ALLOW || exactAllowRule)) {
      const pattern = [rule.executable, ...(rule.argsPrefix ?? [])].join(' ');
      return { decision: rule.action, category: 'commandRule', rule, reason: `Matched command rule: ${pattern}` };
    }
    if (dangerous) {
      return {
        decision: policy.categories.dangerous ?? Decision.ASK,
        category: 'dangerous',
        reason: rule?.action === Decision.ALLOW
          ? 'Command rule matched, but dangerous commands require an exact argument match'
          : 'Command is potentially destructive or can invoke external behavior'
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
