# Buildifyx Desktop Agent

Buildifyx Desktop Agent (`bdxa`) exposes one or more user-controlled workspaces through Buildifyx Cloud or a loopback-only Local MCP gateway while keeping tool permissions enforced on the user's computer.

Current package:

```text
@buildifyx/desktop-agent@0.3.2
```

Default cloud:

```text
https://bdxa.buildifyx.com
```

`bdxa` uses Cloud mode by default. Local MCP is opt-in through `bdxa local`, uses no Cloud login, and keeps its persistent state isolated under `~/.buildifyx/local/`.

## Install

```bash
npm install -g @buildifyx/desktop-agent
```

Check the installation:

```bash
bdxa --version
bdxa doctor
```

## Cloud and Local modes

Cloud remains the default mode:

```bash
bdxa login
bdxa -d --name backend
```

Cloud requires device login and connects to Buildifyx Cloud. Existing Cloud state remains under `~/.buildifyx/`.

Local mode does not use Cloud credentials or the Cloud web console. Start its loopback-only MCP gateway first, then start workspaces with `local` after `bdxa`:

```bash
bdxa local up                 # default 127.0.0.1:3333
bdxa local up 3000            # custom port
bdxa local -d --name backend
bdxa local ls
bdxa local restart --all
bdxa local down
```

Local MCP clients connect to `http://127.0.0.1:<port>/mcp` with **No Auth**. The gateway binds only to `127.0.0.1`; when a remote MCP client needs access, expose that local port through your own HTTPS tunnel or reverse proxy and use the resulting `https://.../mcp` URL. Treat that exposed URL as a secret: anyone who can reach it can invoke MCP tools using each workspace's configured permissions. The shared default policy allows read/write/command operations inside the workspace, while dangerous operations and outside-root access require approval. Forwarded public `Host` values are accepted when no browser Origin is present; non-loopback browser `Origin` values are rejected. Local instances, policies, logs, audit data, and autostart profiles stay under `~/.buildifyx/local/`. Local management uses the same CLI/TUI implementation as Cloud; there is no Local web management UI.

`bdxa local` and other Local instance commands require the Local gateway to be running. `bdxa local down` gracefully stops Local workspaces and the gateway. Background instance records/settings are preserved for `bdxa local start <name|id>`, while foreground run records are released so the same name can be started again later.

## Sign in (Cloud)

```bash
bdxa login
```

The interactive login token is masked while it is entered. For automation:

```bash
bdxa login --token "$BUILDIFYX_LOGIN_TOKEN"
```

Passing a token on the command line can expose it through shell history. A successful login stores the device credential in:

```text
~/.buildifyx/credentials.json
```

## Start a workspace

Foreground mode keeps the TUI attached to the current terminal:

```bash
cd ~/projects/backend
bdxa --name backend
```

If `--name` is omitted, bdxa uses the workspace folder name. The current directory is the primary allowed root unless `--root` is supplied.

```bash
bdxa --root ~/projects/backend --name backend
```

Stop a foreground instance with `Ctrl+C`. To return to the shell without stopping it, press `D` on the Dashboard and confirm with `Enter`. bdxa hands the same instance ID, workspace, and workspace settings to a detached background child; reopen it later with `bdxa attach <name|id>`.

## Background mode

Use `-d` / `--detach` to keep the agent running after the terminal returns:

```bash
bdxa -d --root ~/projects/frontend --name frontend
bdxa -d --root ~/projects/backend --name backend
```

Each running process receives a unique `instanceId`. Local instance metadata and detached logs are stored under:

```text
~/.buildifyx/instances/
```

Background instances can still receive requests that require `ASK`. Use `bdxa attach` from another terminal to review them.

## Manage instances

List foreground, background, stopped, stale, and reconnecting instances:

```bash
bdxa ls
```

`bdxa ps` is an alias. In an interactive terminal, `ls` renders a table including the per-instance autostart state:

```text
ID        NAME       WORKSPACE                         MODE        AUTOSTART  STATUS
84b01e2c  frontend   /Users/me/projects/frontend       background  no         online
21a948af  backend    /Users/me/projects/backend        background  yes        stopped
```

For scripts, use quiet output:

```bash
bdxa ls -q
```

When stdout is redirected or captured by the shell, plain `bdxa ls` automatically switches to full instance IDs only. This keeps Docker-style composition working directly:

```bash
bdxa rm $(bdxa ls)
bdxa rm -f $(bdxa ls -q)
```

Inspect one instance by name, full ID, or unique ID prefix:

```bash
bdxa inspect backend
```

`bdxa inspect` also shows whether autostart is enabled for that instance.

Open the full dashboard of a running instance:

```bash
bdxa attach backend
```

`bdxa attach` mirrors the same Activity, Cloud status, Permissions, Allowed Roots, Command Rules, Diagnostics, and Approval state owned by that running instance. `Ctrl+C` detaches the dashboard without stopping the agent.

Stop and start background instances without removing them:

Stop and start background instances without removing them:

```bash
bdxa stop backend
bdxa stop frontend backend
bdxa stop --all
bdxa start backend
```

`bdxa stop` stops the process but preserves the same `instanceId`, workspace metadata, local policy, command-scope mode, log, and autostart choice. A stopped background instance remains visible in `bdxa ls`. Use `bdxa start <name|id>` to start it again explicitly. `bdxa restart <name|id>` also works and preserves the same instance identity.

Restart one or more background instances without deleting their `instanceId`-scoped Permissions, Allowed Roots, Command Rules, or autostart choice:

```bash
bdxa restart backend
bdxa restart frontend backend
bdxa restart --all
```

`bdxa restart --all` restarts every currently running background instance and skips foreground or stopped instances. `bdxa restart <name|id>` may also start a stopped background instance. Restart refuses a live instance while a tool request or approval is still active. A successful restart reuses the same `instanceId`, name, workspace, log path, command-scope mode, autostart choice, and instance-scoped policy while launching the replacement process from the currently installed bdxa package.
Background mode and autostart are separate. `bdxa -d` only runs the process in the background for the current boot/session. New background instances start with autostart **off**.

Enable autostart for one specific background instance:

```bash
bdxa autostart backend
```

Disable it without stopping the instance:

```bash
bdxa autostart off backend
```

Autostart is opt-in and stored per `instanceId` in `~/.buildifyx/autostart.json`. If an autostart-enabled instance is manually stopped, it stays stopped for the current session but is eligible to start again after the next login/reboot. Restarting an instance does not change its autostart choice.

### Remove

Stop and permanently remove one or more instances:

```bash
bdxa rm backend
bdxa rm frontend backend
bdxa rm --all
```

`bdxa rm` is intentionally different from `bdxa stop`: it removes the instance record, releases its name, deletes its local Dashboard policy, removes its autostart entry, and removes the detached log where applicable. A newly created instance with a new `instanceId` starts from default Permissions, no additional roots, no command rules, and autostart off. Other instances are not changed.

Force-exit through the verified local control channel:

```bash
bdxa rm -f backend
```

`rm` does not blindly signal a PID. Every modern instance exposes a local control endpoint and bdxa verifies the instance identity through that endpoint first. If an old record points at a PID that has been reused by another process, bdxa treats the record as stale and does not kill the unrelated process.

## Multi-workspace behavior

A single signed-in device may run multiple Cloud-mode bdxa instances simultaneously:

```text
MacBook
├─ frontend → instance A
├─ backend  → instance B
└─ mobile   → instance C
```

Each instance has its own workspace root, WebSocket connection, runtime, approval queue, and instance ID. Instances on the same device share only the device credential.

### Instance-specific dashboard settings

Each running instance has its own persisted policy under `~/.buildifyx/instance-settings/<settings-id>/`. The settings identity is derived only from `instanceId`, so two instances never share mutable Dashboard settings even when they use the same workspace root or similar names.

The following settings are instance-specific:

```text
Permission profile / categories
Additional allowed roots
Command rules
Remembered command/location approvals
```

A brand-new instance always starts from the default policy; legacy workspace-level or device-level policy is not imported. The same `instanceId` keeps its settings while it remains the same live instance (including foreground → background handoff and `bdxa attach`). `bdxa rm <name|id>` deletes that instance policy. A normal foreground `Ctrl+C` stops the process and removes its registry entry without treating the stop as an explicit policy reset; the next normal start still receives a new `instanceId` and therefore starts from defaults.

Because `bdxa attach` talks to the running instance over its verified local control channel, editing Permissions/Roots/Commands from an attached dashboard updates only that selected instance.

Instance names are claimed atomically. If `backend` is already running, another explicitly named `backend` instance is rejected instead of creating an ambiguous target. Automatically generated names can fall back to `backend-2`, `backend-3`, and so on.

## ChatGPT workspace selection

Buildifyx Cloud and Local MCP expose the same shared tool definitions:

```text
list_workspaces
use_workspace
```

When exactly one workspace is online, Cloud routes requests automatically. When several are online and no target is selected, Cloud returns `WORKSPACE_SELECTION_REQUIRED` rather than guessing or broadcasting.

ChatGPT can call `list_workspaces`, ask the user when necessary, then call `use_workspace` or pass the optional `workspace` argument directly. Once selected, the Cloud MCP session remembers that workspace for subsequent calls in that chat/session.

This allows separate MCP sessions to work independently, for example:

```text
Chat A → frontend
Chat B → backend
```

A Cloud restart clears in-memory MCP session bindings; the client can reconnect and select the workspace again.

## Protocol v2

Current Cloud-mode bdxa sends:

```json
{
  "type": "device.ready",
  "protocolVersion": 2,
  "deviceId": "dev_...",
  "instanceId": "inst_...",
  "workspace": {
    "name": "backend",
    "path": "/Users/me/projects/backend"
  },
  "mode": "foreground"
}
```

Heartbeats and tool results also identify the instance. Cloud tool calls are routed to one specific instance and are never broadcast to every terminal.

Buildifyx Cloud 0.3 remains backward-compatible with bdxa 0.1 and 0.2 agents. An agent without `protocolVersion` / `instanceId` is registered as a legacy v1 connection and continues to use the original single-connection behavior. The v0.3 management capability is optional, so older agents keep their existing MCP behavior unchanged.

## Web management (v0.3)

bdxa 0.3 can expose authenticated management actions to Buildifyx Cloud for the web console. The Cloud relays semantic actions such as permission changes, allowed-root changes, command-rule changes, instance lifecycle controls, and background autostart; it does not receive direct arbitrary access to local configuration files.

Permissions, additional allowed roots, and command rules remain stored only in the existing instance policy under:

```text
~/.buildifyx/instance-settings/<settings-id>/policy.json
```

Management is deliberately separate from MCP tool calls. ChatGPT MCP sessions do not receive tools that change these security settings. Older agents that do not advertise the management capability continue to connect and use their existing MCP tools normally.

Background instances can opt into autostart from the web console. bdxa stores only the local autostart profile under `~/.buildifyx/autostart.json` and installs a user-level startup hook for macOS (`launchd`), Linux (`systemd --user`), or Windows (Startup). Restored instances keep the same `instanceId`, workspace, local policy, and command-scope mode.

## Permissions

The local agent remains the final permission authority. Available profiles are:

```text
Auto
Read only
Allow all
Custom
```

The default Auto profile permits normal reads, writes, and approved developer commands while asking for dangerous operations or access outside allowed roots.

`Allow all` skips local ASK prompts for configured tools, dangerous actions, and outside-workspace access. It is not an operating-system sandbox.

### Approvals

Foreground TUI requests show the exact action and let the user choose a decision. `Q` denies/goes back and `Ctrl+C` exits bdxa.

Detached instances keep ASK requests pending. `bdxa attach <name|id>` opens the full workspace dashboard, including the normal approval UI, so the request can be resolved without restarting the agent. Outside-workspace scope and the requested operation are evaluated as separate permission gates, and each gate receives its own approval ID so a stale or duplicate approval cannot resolve the next gate. Cloud request timeouts send `tool.cancel` back to bdxa; cancellation is retained across sequential permission gates and is honored until a file operation reaches its final side-effect commit point. After that commit point the operation is allowed to finish rather than reporting a false cancellation. Active and recently completed Cloud request IDs are rejected if replayed, preventing duplicate tool side effects.

### Command executable scope

By default, command execution remains restricted by the local command policy. Advanced users can permit arbitrary executable names with:

```bash
bdxa --unrestricted-commands
```

`--full-access` remains a legacy alias for this command-scope flag. It does not replace the local permission profile and does not provide OS sandboxing.

## MCP tools

Cloud and Local MCP expose the same shared tool definitions:

```text
list_workspaces
use_workspace
get_system_info
list_directory
read_file
write_file
edit_file
run_command
```

For source code, Markdown, and other text, prefer the dedicated file tools instead of shell-based file transport:

- `read_file` accepts optional 1-based `startLine` / `endLine` values so long files can be read in focused ranges without falling back to `sed`, `head`, `tail`, or `cat`. `endLine` values beyond EOF are clamped, and the response reports `startLine`, `endLine`, `returnedLineCount`, `truncated`, and `nextStartLine`.
- `write_file` should be used to create text/source files instead of shell redirection or heredocs.
- `edit_file` should be used for source/text modifications instead of `sed`, `perl`, or inline scripting patches when possible.
- `run_command` is intended for commands such as tests, builds, Git, and package-manager operations. Large source/file contents should not be transported inside command arguments.

The local agent executes the machine-facing tools only after the request passes its local permission policy.

## Audit log

Cloud-mode agent activity is appended to `~/.buildifyx/audit.log`. Local-mode activity is isolated in `~/.buildifyx/local/audit.log`.

Audit events include instance context containing the instance ID, workspace name, workspace path, and transport context where applicable so activity from multiple terminals can be distinguished.

## Status

```bash
bdxa status
```

Shows device authentication/Cloud reachability and the number of active Cloud-mode instances. Use `bdxa ls` to inspect Cloud workspaces; use `bdxa local status` or `bdxa local ls` for Local mode.

The foreground TUI also follows the real Cloud state and displays connecting, connected, reconnecting, disconnected, or revoked rather than assuming the socket is connected.

`RECENT ACTIVITY` shows the MCP tool name for each request, follows the newest request while the user is already at the end of the list, and keeps the selected request stable while older activity is being inspected. The header always shows the running agent version. If a newer npm version exists, the dashboard shows an update notice with `bdxa update`. When `bdxa attach` connects to an older background agent while a newer package is already installed, the dashboard asks the user to restart that instance. Very small terminal windows fall back to a compact status view instead of forcing bordered panels beyond the available rows.

## Logout

```bash
bdxa logout
```

Logout revokes the device credential, so all instances using that credential lose Cloud access and shut down their Cloud connection. Use `Ctrl+C` for a foreground instance or `bdxa stop <name|id>` for a managed background instance when the goal is only to stop it; use `bdxa rm` only when the instance and its local settings should be removed.

## Update

Most user-facing bdxa commands check the npm registry at startup. The check is skipped for `bdxa update`, `bdxa doctor`, and internal background/handoff child processes. If the installed version is older than the current npm `latest`, CLI commands print an update warning and the interactive dashboard shows the available version.

```bash
bdxa update
bdxa update --restart
```

`bdxa update` installs the latest public package globally. `bdxa update --restart` updates the package, restarts running Cloud background instances, and—when the Local gateway is active—restarts that gateway on the same port and then restarts running Local background instances. Foreground instances and stopped instances are not started automatically. Set `BUILDIFYX_SKIP_UPDATE_CHECK=1` only when an automated or offline environment must skip the startup version check.

## Useful commands

```bash
bdxa login
bdxa --name frontend
bdxa -d --root ~/projects/backend --name backend
bdxa ls
bdxa ls -q
bdxa attach backend
bdxa inspect backend
bdxa stop backend
bdxa autostart backend
bdxa restart backend
bdxa autostart off backend
bdxa restart --all
bdxa rm backend
bdxa rm frontend backend
bdxa rm $(bdxa ls)
bdxa rm --all
bdxa status
bdxa doctor
bdxa update
bdxa update --restart

bdxa local up
bdxa local -d --name backend
bdxa local ls
bdxa local restart --all
bdxa local down
bdxa --version
```

## Security notes

- Buildifyx Cloud does not bypass the local permission system.
- Local MCP uses **No Auth** and binds only to `127.0.0.1`. If you expose it through an HTTPS tunnel/reverse proxy, treat the resulting MCP URL as a secret: anyone who can reach it can invoke tools under the workspace permissions. The shared default policy allows read/write/command operations inside the workspace; dangerous operations and outside-root access require approval.
- Device credentials are separate from login tokens.
- Each running workspace process has a separate instance identity and workspace root.
- Tool arguments received through Cloud or Local MCP are validated again by the local Agent before permission evaluation or execution.
- Outside-workspace scope and operation permissions are independent gates; allowing a location cannot override a denied write, command, or dangerous-operation policy.
- Remote Cloud origins must use HTTPS/WSS. Plain HTTP/WS is accepted only for loopback development endpoints such as `localhost` and `127.0.0.1`.
- The runtime stops accepting new tool calls as soon as shutdown begins, and duplicate active/recent request IDs are rejected to prevent replayed side effects.
- `bdxa rm` verifies a local instance control channel instead of trusting a stale PID record.
- Local credentials, policies, instance metadata, audit logs, and detached instance logs use restricted local file permissions where supported.
- Commands execute without a shell unless a supported executable itself starts one.
- Restricted Git commands still require approval when options can invoke external helpers, pagers, text conversion, or write command output to a file.
- File access is constrained by configured roots and path checks.
- Keep `~/.buildifyx/credentials.json` private.
