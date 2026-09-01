export function printHelp() {
  console.log(`bdxa — Buildifyx Desktop Agent

Usage:
  bdxa [options]
  bdxa <command> [options]

Getting started:
  1. bdxa login          Sign in this computer
  2. cd <workspace>      Open the project ChatGPT may use
  3. bdxa                Connect to Buildifyx Cloud

Commands:
  login       Sign in and register this computer
  logout      Sign out and revoke this device credential
  status      Show whether this device is ready to connect
  connect     Connect to Buildifyx Cloud (same as running bdxa)
  doctor      Check the local agent environment
  update      Update Buildifyx Desktop Agent from npm
  help        Show this help message

Options:
  --root <path>     Workspace ChatGPT may access (default: current directory)
  -h, --help        Show help
  -v, --version     Show installed version

Examples:
  bdxa login
  bdxa
  bdxa --root ~/projects/my-app
  bdxa status
  bdxa doctor

Advanced:
  bdxa local [--root <path>] [--port 3333]   Start the local MCP server for development
  --unrestricted-commands                    Permit arbitrary executable names; not sandboxed
  --no-tui                                   Disable the interactive terminal UI
  bdxa login --cloud <url>                   Use a custom Buildifyx Cloud origin
  bdxa login --token <token>                 Non-interactive login; may expose token in shell history

Legacy compatibility:
  --full-access                              Alias for --unrestricted-commands

Run bdxa inside the workspace you want ChatGPT to use. Dangerous actions and access outside allowed roots still follow your local permission policy.
`);
}
