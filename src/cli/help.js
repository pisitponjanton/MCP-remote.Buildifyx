export function printHelp() {
  console.log(`bdxa — Buildifyx Desktop Agent

Usage:
  bdxa [options]
  bdxa <command> [options]

Start workspaces:
  bdxa                         Run this workspace in the foreground
  bdxa -d                      Run this workspace in the background
  bdxa --name <name>           Give the workspace a stable name for ChatGPT
  bdxa --root <path>           Use a workspace without changing directory
  Dashboard: D + Enter         Move the same running instance to background

Manage instances:
  bdxa ls                      List instances (IDs only when output is piped)
  bdxa ls -q                   Print instance IDs only
  bdxa ps                      Alias for bdxa ls
  bdxa inspect <name|id>       Show instance details
  bdxa attach <name|id>        Open the full dashboard for a running instance
  bdxa rm <name|id...>         Stop/remove instances and reset their local settings
  bdxa rm -f <name|id...>      Force-exit through the verified local control channel
  bdxa rm --all                Remove all instances and reset their local settings

Account and maintenance:
  bdxa login                   Sign in and register this computer
  bdxa logout                  Revoke this device credential
  bdxa status                  Check device authentication status
  bdxa doctor                  Check the local agent environment
  bdxa update                  Update Buildifyx Desktop Agent from npm
  bdxa help                    Show this help message

Options:
  -d, --detach                 Run as a detached background instance
  --name <name>                Workspace/instance name (default: folder name)
  --root <path>                Workspace ChatGPT may access (default: current directory)
  --unrestricted-commands      Permit arbitrary executable names; not sandboxed
  --no-tui                     Disable the interactive terminal UI
  -h, --help                   Show help
  -v, --version                Show installed version

Examples:
  cd ~/projects/frontend && bdxa --name frontend
  bdxa -d --root ~/projects/backend --name backend
  bdxa ls
  bdxa attach backend
  bdxa rm frontend backend
  bdxa rm $(bdxa ls)
  bdxa rm -f $(bdxa ls -q)
  bdxa rm --all

Each instanceId owns its own Permissions, additional allowed roots, and command rules, even when multiple instances use the same workspace path. New instances start from defaults; removing/stopping an instance deletes its local policy. Foreground → background handoff and bdxa attach keep the same instanceId and therefore preserve that running instance's settings. Buildifyx Desktop Agent 0.2+ connects through Buildifyx Cloud only.
`);
}
