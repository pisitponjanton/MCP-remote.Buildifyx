export function printHelp() {
  console.log(`bdxa — Buildifyx Desktop Agent

Usage:
  bdxa [options]
  bdxa <command> [options]

Start workspaces:
  bdxa                         Run this workspace in the foreground
  bdxa -d                      Run this workspace in the background (autostart is OFF by default)
  bdxa --name <name>           Give the workspace a stable name for ChatGPT
  bdxa --root <path>           Use a workspace without changing directory
  Dashboard: D + Enter         Move the same running instance to background

Manage instances:
  bdxa ls                      List instances, status, mode, and autostart state
  bdxa ls -q                   Print instance IDs only
  bdxa ps                      Alias for bdxa ls
  bdxa inspect <name|id>       Show instance details
  bdxa attach <name|id>        Open the full dashboard for a running instance
  bdxa start <name|id...>      Start stopped background instances
  bdxa stop <name|id...>       Stop background instances but keep settings/autostart
  bdxa stop --all              Stop every running background instance
  bdxa restart <name|id...>    Restart/start background instances and keep their settings
  bdxa restart --all           Restart every currently running background instance
  bdxa autostart <name|id>     Start this background instance automatically after login/reboot
  bdxa autostart off <name|id> Disable autostart without stopping the instance
  bdxa rm <name|id...>         Stop/remove instances and reset their local settings
  bdxa rm -f <name|id...>      Force-exit through the verified local control channel
  bdxa rm --all                Remove all instances, policies, and autostart entries

Account and maintenance:
  bdxa login                   Sign in and register this computer
  bdxa logout                  Revoke this device credential
  bdxa status                  Check device authentication status
  bdxa doctor                  Check the local agent environment
  bdxa update                  Update Buildifyx Desktop Agent from npm
  bdxa update --restart        Update, then restart all running background instances
  bdxa help                    Show this help message

Options:
  -d, --detach                 Run as a detached background instance; does not enable autostart
  --name <name>                Workspace/instance name (default: folder name)
  --root <path>                Workspace ChatGPT may access (default: current directory)
  --unrestricted-commands      Permit arbitrary executable names; not sandboxed
  --no-tui                     Disable the interactive terminal UI
  -h, --help                   Show help
  -v, --version                Show installed version

Examples:
  cd ~/projects/frontend && bdxa --name frontend
  bdxa -d --root ~/projects/backend --name backend
  bdxa autostart backend
  bdxa stop backend
  bdxa start backend
  bdxa restart backend
  bdxa autostart off backend
  bdxa attach backend
  bdxa rm frontend backend
  bdxa rm $(bdxa ls)
  bdxa rm -f $(bdxa ls -q)
  bdxa rm --all

Background and autostart are separate. Starting with -d only keeps the process in the background for the current boot/session. Autostart is opt-in per instance and remains enabled across stop/restart until explicitly disabled or the instance is removed. bdxa stop preserves the instance record, policy, and autostart setting. bdxa rm deletes the instance record, local policy, and its autostart entry.

Each instanceId owns its own Permissions, additional allowed roots, and command rules, even when multiple instances use the same workspace path. New instances start from defaults. Foreground Ctrl+C removes the running registry record but does not reset the policy unless the instance is explicitly removed. Foreground → background handoff and bdxa attach keep the same instanceId and therefore preserve that instance's settings. Buildifyx Desktop Agent 0.2+ connects through Buildifyx Cloud only.
`);
}
