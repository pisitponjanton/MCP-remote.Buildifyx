# Buildifyx Desktop Agent

Buildifyx Desktop Agent (`bdxa`) lets ChatGPT work with files and approved developer commands on your computer through MCP.

The agent runs locally, shows every MCP action in a terminal UI, and lets you control what ChatGPT is allowed to read, write, or execute.

> Current package: `@buildifyx/desktop-agent@0.1.0`

## Requirements

- Node.js 20 or newer
- npm
- A terminal with interactive TTY support for the full-screen UI

## Install

Install globally from npm:

```bash
npm install -g @buildifyx/desktop-agent
```

Check the installation:

```bash
bdxa --version
```

Run diagnostics:

```bash
bdxa doctor
```

## Start the agent

Run `bdxa` inside the project you want ChatGPT to access:

```bash
cd ~/projects/my-app
bdxa
```

Or choose a workspace explicitly:

```bash
bdxa --root ~/projects/my-app
```

By default the MCP server listens on:

```text
http://127.0.0.1:3333/mcp
```

Health information is available at:

```text
http://127.0.0.1:3333/health
```

The registered MCP tool manifest is available at:

```text
http://127.0.0.1:3333/tools
```

Use another port if needed:

```bash
bdxa --port 4444
```

## Terminal UI

When `bdxa` runs in an interactive terminal it opens a full-screen TUI.

The dashboard shows:

- MCP connection status
- Registered tool count and schema fingerprint
- Recent MCP activity
- The currently selected request
- Files and directories accessed by MCP file tools
- Commands executed by `run_command`
- Permission decisions
- Pending approval requests
- Current permission profile

The UI automatically adapts to terminal size. Wide terminals use side-by-side panels; narrow terminals stack the panels vertically.

### Main controls

```text
↑ / ↓      Select activity
P          Permissions
R          Allowed roots
C          Custom command rules
T          MCP tools
L          Show audit log path
? / H      Help
Q          Back
Ctrl+C     Exit Buildifyx Desktop Agent
```

`Q` is always used to go back or cancel. Use `Ctrl+C` to stop the agent.

## Permissions

Buildifyx Desktop Agent uses three permission states:

```text
ALLOW   Run without asking
ASK     Ask in the TUI before continuing
DENY    Reject the request
```

The main permission categories are:

- Read files
- Write files
- Normal commands
- Dangerous commands
- Access outside allowed roots

Open the permission editor with:

```text
P
```

Controls:

```text
↑ / ↓      Select permission
← / →      Change ALLOW / ASK / DENY
A          Auto profile
O          Read-only profile
F          Full-access profile
Q          Back
```

### Auto

Recommended for normal development use.

```text
Read             ALLOW
Write            ALLOW
Commands         ALLOW
Dangerous        ASK
Outside root     ASK
```

### Read only

Useful when you want ChatGPT to inspect a project without freely changing or executing it.

```text
Read             ALLOW
Write            ASK
Commands         ASK
Dangerous        ASK
Outside root     ASK
```

### Full access

Allows all configured operations without confirmation.

Full access is powerful and is **not an operating-system sandbox**. Commands run with the permissions of your current OS user.

## Approval requests

When a permission is set to `ASK`, the MCP request pauses and the TUI shows an approval panel before the action is executed.

Example:

```text
APPROVAL REQUIRED

docker ps
Matched command rule: docker ps

› Allow once
  Always allow this request
  Deny

↑↓ Select   Enter Confirm   Q Back/Deny
```

Options:

- **Allow once** — allow only the current request
- **Always allow this request** — save a matching permission rule
- **Deny** — reject the request

Pressing `Q` on an approval request denies the request and returns control to the dashboard.

## Custom command rules

Restricted mode starts with a small set of developer commands. Other executables can be added from the TUI.

Open custom command rules with:

```text
C
```

Controls:

```text
↑ / ↓      Select rule
← / →      Change ALLOW / ASK / DENY
A          Add rule
D          Delete rule
Q          Back
```

A rule is an executable plus an optional argument prefix.

Examples:

```text
docker        ASK
docker ps     ALLOW
rm -rf        ASK
```

More specific rules take priority over broader rules. For example:

```text
docker        ALLOW
docker ps     ASK
```

`docker ps` will still ask for approval.

Commands are executed without a shell string. Buildifyx Desktop Agent passes the executable and arguments separately.

## Allowed roots

The directory passed through `--root` is the primary workspace.

Open the roots editor with:

```text
R
```

You can add other directories that ChatGPT may access.

Controls:

```text
↑ / ↓      Select root
A          Add root
D          Delete additional root
Q          Back
```

The primary root cannot be deleted from the TUI.

Access outside the configured roots follows the `Outside root` permission setting:

- `ALLOW` — allow access
- `ASK` — request approval first
- `DENY` — reject access

Access to `.git` internals remains blocked by the agent's path protection.

## MCP tools

Open the MCP tools screen with:

```text
T
```

Current tools:

```text
get_system_info
list_directory
read_file
write_file
edit_file
run_command
```

The tools screen shows:

- Registered tool count
- Tool names
- Permission category for each tool
- Current schema fingerprint
- Whether the tool manifest changed since the previous agent run

If the TUI shows:

```text
TOOLS CHANGED
```

then the local agent has a different MCP tool definition than the previous run. If ChatGPT still shows an older set of functions, refresh or reconnect the MCP integration so ChatGPT performs tool discovery again.

You can also inspect the current manifest directly:

```text
http://127.0.0.1:3333/tools
```

## File access

File tools work with UTF-8 text files up to 1 MiB.

The dashboard records explicit file activity such as:

```text
READ
WRITE
CREATE
LIST
```

For `run_command`, the agent displays the executable, arguments, and working directory. It does not claim to trace every file opened internally by a child process.

## Audit log

MCP activity and permission decisions are written to:

```text
~/.buildifyx/audit.log
```

Press `L` in the dashboard to display the active audit log path.

The audit log records metadata such as tool names, paths, commands, permission decisions, and durations. Full file contents sent to write/edit operations are not intentionally copied into the audit log.

Permission settings are stored at:

```text
~/.buildifyx/policy.json
```

The last MCP tool manifest is stored at:

```text
~/.buildifyx/tool-manifest.json
```

## Non-interactive mode

Disable the TUI explicitly with:

```bash
bdxa --no-tui
```

Non-interactive environments also fall back to this mode automatically.

When a permission is set to `ASK` but no interactive TUI is available, the request returns a confirmation-required error instead of waiting indefinitely.

## Startup options

```text
--root <path>       Primary workspace directory
--port <number>     MCP port (default: 3333)
--full-access       Permit arbitrary executable names
--no-tui            Disable the interactive terminal UI
```

Examples:

```bash
bdxa
bdxa --root ~/projects/my-app
bdxa --root ~/projects/my-app --port 4444
bdxa --full-access
bdxa --no-tui
```

## Other commands

Show the installed version:

```bash
bdxa --version
```

Check the environment and package version:

```bash
bdxa doctor
```

Update to the latest published npm version:

```bash
bdxa update
```

Show CLI help:

```bash
bdxa --help
```

## Connecting ChatGPT

Buildifyx Desktop Agent exposes an MCP endpoint locally at `/mcp`.

If ChatGPT is connecting from outside your machine, the MCP endpoint must be reachable through the secure tunnel or remote connection method you are using. Do not expose the local MCP port directly to the public internet without appropriate access controls.

After changing or updating MCP tools, reconnect or refresh the MCP integration if ChatGPT still displays an older tool list.

## Troubleshooting

### ChatGPT does not see a new function

1. Press `T` in `bdxa` and confirm the function appears in **MCP TOOLS**.
2. Check whether the TUI shows `TOOLS CHANGED`.
3. Open `/tools` and confirm the tool is present in the current manifest.
4. Restart `bdxa` if the running process was started before the update.
5. Refresh or reconnect the MCP integration in ChatGPT.

If the function appears in `bdxa` but not in ChatGPT, the local agent is serving the new tool set and ChatGPT likely needs to perform tool discovery again.

### A command is blocked

Open `C` and check the matching custom command rule, or open `P` and review command permissions.

Example:

```text
docker ps → ASK
```

The next matching request should pause and display an approval panel.

### `ASK` does not show a prompt

Make sure:

- `bdxa` is running with the interactive TUI
- the command or permission rule is actually set to `ASK`
- you restarted `bdxa` after installing a newer agent version
- a broader command rule is not overriding your expectation; the agent gives priority to the most specific matching rule

### The UI is too small

Resize the terminal. The layout responds automatically and switches to stacked panels on narrow terminals.

### Exit the agent

Use:

```text
Ctrl+C
```

`Q` is reserved for Back/Cancel inside the UI.

## Security notes

Buildifyx Desktop Agent can read and modify files and execute approved commands as your current operating-system user.

Before enabling Full access or approving a destructive command, verify the requested command, arguments, path, and working directory shown in the TUI.

Command execution is not an OS sandbox.

---

Buildifyx Desktop Agent is currently in early development. Review permissions carefully when using it on important projects.
