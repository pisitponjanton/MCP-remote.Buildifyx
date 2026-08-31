export function printHelp() {
  console.log(`bdxa — Buildifyx Desktop Agent

Usage:
  bdxa [command] [options]
  buildifyx-agent [command] [options]

Default:
  Running bdxa with no command starts remote mode with the interactive TUI when a terminal is available.

Commands:
  remote, r   Start the private MCP HTTP server on 127.0.0.1
  doctor, d   Check environment, root access, and package version
  update, u   Update Buildifyx Desktop Agent to the latest npm version
  help        Show this help message

Global options:
  -h, --help        Show help
  -v, --version     Show installed version

Remote options:
  --root <path>     Primary workspace root (default: current directory)
  --port <number>   Local MCP port (default: 3333)
  --full-access     Permit arbitrary executable names; command execution is not sandboxed.
  --no-tui          Disable the interactive TUI. Ask permissions return confirmation errors.

TUI shortcuts:
  1 / a             Activity
  2 / p             Permissions
  3 / r             Pending requests
  q                 Quit

Examples:
  bdxa
  bdxa --root ~/projects
  bdxa r --root ~/projects
  bdxa r --root ~/projects --full-access
  bdxa r --no-tui
  bdxa doctor
  bdxa update
  bdxa -v
`);
}
