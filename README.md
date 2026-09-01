# Buildifyx Desktop Agent

Buildifyx Desktop Agent (`bdxa`) connects a user-controlled computer to Buildifyx Cloud so ChatGPT can use approved MCP tools on that machine.

Default cloud:

```text
https://bdxa.buildifyx.com
```

Agent connection:

```text
wss://bdxa.buildifyx.com/agent
```

Current package version:

```text
@buildifyx/desktop-agent@0.1.0
```

## Install

```bash
npm install -g @buildifyx/desktop-agent
```

Check the installation:

```bash
bdxa --version
bdxa doctor
```

## 1. Login

Ask your Buildifyx administrator for a login token, then run:

```bash
bdxa login
```

Paste the token when prompted. Interactive token input is masked so the token is not echoed to the terminal.

If you run `bdxa` before signing in, an interactive terminal will guide you through this sign-in step automatically and then continue connecting the workspace.

For internal automation you can also use:

```bash
bdxa login --token "$BUILDFIYX_LOGIN_TOKEN"
```

Using `--token` directly may expose the token through shell history, so interactive login is preferred.

A successful login registers this computer as a device and stores its device credential locally in:

```text
~/.buildifyx/credentials.json
```

On macOS and Linux the agent attempts to keep this file readable only by the current user.

Login tokens are intended to be short-lived or one-time credentials. The device credential returned by Buildifyx Cloud is what `bdxa` uses for subsequent cloud connections.

## 2. Check login status

```bash
bdxa status
```

The command shows the configured cloud, device ID, account when available, credential expiry, and whether Buildifyx Cloud currently accepts the device credential.

## 3. Connect the device

Run `bdxa` from the directory you want ChatGPT to work in:

```bash
cd ~/projects/my-project
bdxa
```

Or choose the workspace explicitly:

```bash
bdxa --root ~/projects/my-project
```

For advanced command workflows, `--unrestricted-commands` permits arbitrary executable names. It does not bypass the local permission profile and it is not an OS sandbox:

```bash
bdxa --unrestricted-commands
```

`--full-access` remains as a legacy alias for `--unrestricted-commands`.

`bdxa` now connects outward to Buildifyx Cloud. The computer does not need to expose a public port for normal cloud operation.

Connection path:

```text
ChatGPT
   ↓
Buildifyx Cloud
   ↓
Secure WebSocket
   ↓
bdxa
   ↓
Local permissions
   ↓
Your files and commands
```

The local agent remains the final permission authority. A cloud request still has to pass the permission policy running on the user's computer before a tool can execute.

## Cloud protocol

When the agent connects, it authenticates the WebSocket handshake using the device credential and sends a `device.ready` message containing the agent version, device information, and MCP tool manifest hash.

The cloud can send a tool request such as:

```json
{
  "type": "tool.call",
  "requestId": "req_123",
  "tool": "read_file",
  "arguments": {
    "path": "README.md"
  }
}
```

The agent routes it through the same local runtime and permission system used by local MCP mode.

Successful requests return:

```json
{
  "type": "tool.result",
  "requestId": "req_123",
  "result": {}
}
```

Failed requests return:

```json
{
  "type": "tool.error",
  "requestId": "req_123",
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "Permission denied"
  }
}
```

The agent also sends heartbeats and reconnects automatically with backoff when the cloud connection drops.

## Permissions

The default Auto profile allows normal reads, writes, and approved developer commands while asking before dangerous operations or access outside allowed roots.

Available profiles are:

```text
Auto
Read only
Allow all
Custom
```

The Allow all permission profile skips local ASK prompts for configured tools, dangerous actions, and outside-workspace access. It does not make command execution an operating-system sandbox.

### ASK requests

When a rule resolves to `ASK`, the cloud request waits while the TUI displays an approval prompt:

```text
APPROVAL REQUIRED

docker ps

> Allow once
  Always allow this request
  Deny
```

The tool executes only after local approval.

If the agent is running with `--no-tui`, an ASK request returns a confirmation-required error instead of waiting indefinitely.

### Custom command rules

Command rules match executable name plus argument prefix.

For example:

```text
docker       ALLOW
docker ps    ASK
```

The more specific rule wins, so `docker ps` asks even though the broader `docker` rule allows other Docker commands.

Commands are executed without a shell.

## Allowed roots

The primary root is the directory supplied through `--root`, or the current working directory when omitted.

Additional roots can be managed from the TUI.

Requests outside configured roots follow the `outsideRoot` permission setting and may be allowed, denied, or require approval.

`.git` internals remain protected by the local path security layer.

## MCP tools

The current agent exposes:

```text
get_system_info
list_directory
read_file
write_file
edit_file
run_command
```

The agent sends its tool count and schema hash to Buildifyx Cloud when connecting so the cloud can detect which tool definition set the device is running.

## TUI controls

Main screen:

```text
↑↓       Select recent activity
P        Permissions
? / H    Help
Q        Back
R        Allowed roots (advanced)
C        Command rules (advanced)
T        Diagnostics and MCP tools
Ctrl+C   Quit
```

Approval screen:

```text
↑↓       Select decision
Enter    Confirm
Q        Deny / Back
Ctrl+C   Quit
```

## Audit log

Local activity is recorded at:

```text
~/.buildifyx/audit.log
```

The audit log records tool names, permission decisions, paths, commands, status, and timing information. Write/edit payload contents are redacted rather than intentionally duplicated into the audit log.

## Logout

```bash
bdxa logout
```

The agent asks Buildifyx Cloud to revoke the device credential and then removes the local credential file.

If the cloud cannot be reached, `bdxa` still removes the local credential and reports that remote revocation failed.

## Update

```bash
bdxa update
```

Then restart the agent:

```bash
bdxa
```

## Useful commands

```bash
bdxa login
bdxa status
bdxa --root ~/projects
bdxa connect --root ~/projects
bdxa logout
bdxa doctor
bdxa update
bdxa --version
```

## Local MCP compatibility mode

For local development or debugging, the previous localhost MCP server remains available explicitly:

```bash
bdxa local --root ~/projects --port 3333
```

Normal users should use cloud mode by running `bdxa` without the `local` command.

## Troubleshooting

### `Not logged in`

Run:

```bash
bdxa login
```

### `Device credential has expired`

Request a new login token from your administrator and run `bdxa login` again.

### ASK does not execute immediately

This is expected. The request is waiting for a local approval in the TUI.

### Cloud is temporarily unavailable

Leave `bdxa` running. The cloud client automatically retries with exponential backoff.

### Need to inspect the current tools

Press `T` in the TUI to see the current tool count and schema hash.

## Security notes

- Buildifyx Cloud does not replace the local permission system.
- Device authentication uses a dedicated device credential, separate from the login token.
- Command execution uses direct executable invocation rather than shell command strings.
- File access is constrained by configured roots and path checks.
- `--unrestricted-commands` is not an OS sandbox; commands run with the permissions of the operating-system user running `bdxa`.
- Keep `~/.buildifyx/credentials.json` private.
