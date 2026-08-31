export function printHelp() {
  console.log(`bdxa — Buildifyx Desktop Agent

Usage:
  bdxa [command] [options]
  buildifyx-agent [command] [options]

Default:
  Running bdxa with no command starts remote mode in restricted command mode.

Commands:
  remote, r   Start the private MCP HTTP server on 127.0.0.1
  doctor, d   Check environment, root access, and package version
  update, u   Update Buildifyx Desktop Agent to the latest npm version
  help        Show this help message

Global options:
  -h, --help        Show help
  -v, --version     Show installed version

Remote options:
  --root <path>     Directory file tools are allowed to access (default: current directory)
  --port <number>   Local MCP port (default: 3333)
  --full-access     Allow powerful runtimes/package executors. Commands are not sandboxed.

Examples:
  bdxa
  bdxa --root ~/projects
  bdxa r --root ~/projects
  bdxa r --root ~/projects --full-access
  bdxa doctor
  bdxa update
  bdxa -v
`);
}
