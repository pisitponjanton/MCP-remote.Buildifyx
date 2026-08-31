export function printHelp() {
  console.log(`bdxa — Buildifyx Desktop Agent

Usage:
  bdxa [options]
  bdxa <command> [options]

Default:
  Running bdxa connects this device to Buildifyx Cloud at bdxa.buildifyx.com.
  Login once with a one-time token before connecting.

Commands:
  login       Authenticate this device with a login token
  logout      Revoke this device credential and remove it locally
  status      Show device authentication status
  connect     Connect to Buildifyx Cloud (same as default bdxa)
  local       Start the legacy local MCP HTTP server for development
  doctor, d   Check environment, root access, and package version
  update, u   Update Buildifyx Desktop Agent from npm
  help        Show this help message

Global options:
  -h, --help        Show help
  -v, --version     Show installed version

Cloud options:
  --root <path>     Primary workspace root (default: current directory)
  --full-access     Permit arbitrary executable names; execution is not sandboxed
  --no-tui          Disable the interactive TUI; ASK returns confirmation-required

Login options:
  --token <token>   Login token (prefer interactive input to avoid shell history)
  --cloud <url>     Cloud origin (default: https://bdxa.buildifyx.com)

Local development options:
  --root <path>     Primary workspace root
  --port <number>   Local MCP port (default: 3333)
  --full-access     Permit arbitrary executable names
  --no-tui          Disable the interactive TUI

Examples:
  bdxa login
  bdxa status
  bdxa --root ~/projects
  bdxa connect --root ~/projects
  bdxa logout
  bdxa local --root ~/projects --port 3333
  bdxa doctor
  bdxa update
  bdxa -v
`);
}
