# Buildifyx Desktop Agent

Buildifyx Desktop Agent (`bdxa`) connects one or more local workspaces to Buildifyx Cloud so ChatGPT can use approved MCP tools on the user's computer.

Current package:

```text
@buildifyx/desktop-agent@0.2.0
```

Default cloud:

```text
https://bdxa.buildifyx.com
```

`bdxa` 0.2 is cloud-only. The previous local MCP HTTP mode has been removed.

## Install

```bash
npm install -g @buildifyx/desktop-agent
```

Check the installation:

```bash
bdxa --version
bdxa doctor
```

## Sign in

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

List foreground, background, stale, and reconnecting instances:

```bash
bdxa ls
```

`bdxa ps` is an alias. In an interactive terminal, `ls` renders a table:

```text
ID        NAME       WORKSPACE                         MODE        STATUS
84b01e2c  frontend   /Users/me/projects/frontend       background  online
21a948af  backend    /Users/me/projects/backend        foreground  online
```

For scripts, use quiet output:

```bash
bdxa ls -q
```

When stdout is redirected or captured by the shell, plain `bdxa ls` automatically switches to full instance IDs only. This makes Docker-style composition work directly:

```bash
bdxa rm $(bdxa ls)
bdxa rm -f $(bdxa ls -q)
```

Inspect one instance by name, full ID, or unique ID prefix:

```bash
bdxa inspect backend
```

Open the full dashboard of a running instance:

```bash
bdxa attach backend
```

`bdxa attach` mirrors the same Activity, Cloud status, Permissions, Allowed Roots, Command Rules, Diagnostics, and Approval state owned by that running instance. Changes made from the attached dashboard are applied only to that instance's policy. `Ctrl+C` detaches the dashboard without stopping the agent; use `bdxa rm` to stop the instance.

Stop and remove one or more instances:

```bash
bdxa rm backend
bdxa rm frontend backend
```

`bdxa rm` also deletes that instance's local Dashboard policy. A newly created instance always starts from the default Permissions, no additional allowed roots, no custom command rules, and no remembered command/location approvals. Other instances are not changed, even when they use the same workspace root or the same workspace name later.

Remove every local instance and reset each instance's local Dashboard policy:

```bash
bdxa rm --all
```

Force-exit through the verified local control channel:

```bash
bdxa rm -f backend
```
`rm` does not blindly signal a PID. Every v0.2 instance exposes a local control endpoint and bdxa verifies the instance ID and PID through that endpoint first. If an old record points at a PID that has been reused by another process, bdxa treats the record as stale and does not kill the unrelated process.

## Multi-workspace behavior

A single signed-in device may run multiple bdxa 0.2 instances simultaneously:

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

Buildifyx Cloud exposes:

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

bdxa 0.2 sends:

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

Buildifyx Cloud 0.2 remains backward-compatible with bdxa 0.1 agents. An agent without `protocolVersion` / `instanceId` is registered as a legacy v1 connection and continues to use the original single-connection behavior.

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

Detached instances keep ASK requests pending. `bdxa attach <name|id>` opens the full workspace dashboard, including the normal approval UI, so the request can be resolved without restarting the agent. Cloud request timeouts send `tool.cancel` back to bdxa; a timed-out pending approval is cancelled so approving it later cannot trigger a delayed action.

### Command executable scope

By default, command execution remains restricted by the local command policy. Advanced users can permit arbitrary executable names with:

```bash
bdxa --unrestricted-commands
```

`--full-access` remains a legacy alias for this command-scope flag. It does not replace the local permission profile and does not provide OS sandboxing.

## MCP tools

Cloud exposes:

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

The local agent executes the machine-facing tools only after the request passes its local permission policy.

## Audit log

Local activity is appended to:

```text
~/.buildifyx/audit.log
```

Events from bdxa 0.2 include instance context containing the instance ID, workspace name, and workspace path so activity from multiple terminals can be distinguished.

## Status

```bash
bdxa status
```

Shows device authentication/Cloud reachability and the number of active local instances. Use `bdxa ls` to inspect individual workspaces.

The foreground TUI also follows the real Cloud state and displays connecting, connected, reconnecting, disconnected, or revoked rather than assuming the socket is connected.

## Logout

```bash
bdxa logout
```

Logout revokes the device credential, so all instances using that credential lose Cloud access and shut down their Cloud connection. Use `Ctrl+C` or `bdxa rm` when the goal is only to stop one workspace.

## Update

```bash
bdxa update
```

## Useful commands

```bash
bdxa login
bdxa --name frontend
bdxa -d --root ~/projects/backend --name backend
bdxa ls
bdxa ls -q
bdxa attach backend
bdxa inspect backend
bdxa rm backend
bdxa rm frontend backend
bdxa rm $(bdxa ls)
bdxa rm --all
bdxa status
bdxa doctor
bdxa update
bdxa --version
```

## Security notes

- Buildifyx Cloud does not bypass the local permission system.
- Device credentials are separate from login tokens.
- Each v0.2 process has a separate instance identity and workspace root.
- Cloud routes each request to one explicit instance; it does not broadcast requests across workspaces.
- `bdxa rm` verifies a local instance control channel instead of trusting a stale PID record.
- Local instance metadata and policy files are written with restricted file permissions where supported.
- Commands execute without a shell unless a supported executable itself starts one.
- File access is constrained by configured roots and path checks.
- Keep `~/.buildifyx/credentials.json` private.
