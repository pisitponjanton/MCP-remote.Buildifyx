# Buildifyx Desktop Agent MVP

Small private MCP CLI for root-scoped file access:

```text
ChatGPT
  ↓
OpenAI Secure MCP Tunnel
  ↓ outbound HTTPS
bdxa remote
  ↓
Local machine (configured root)
```

This MVP intentionally does **not** include SaaS, user accounts, OAuth, or device registry.

## Tools

- `get_system_info`
- `list_directory`
- `read_file`
- `write_file`
- `edit_file`
- `run_command`

`get_system_info`, `list_directory`, and `read_file` are read-only. `write_file` creates new UTF-8 text files without overwriting existing files. `edit_file` can overwrite a file, replace an inclusive line range, or replace a character range using one-based line and column positions. File tools are constrained to the root directory passed to the CLI, including protection against `..` traversal, symlink escape, and access to `.git` internals.

`run_command` executes allowlisted developer commands with `execFile`, `shell: false`, a bounded timeout, bounded output, and a working directory constrained to the configured root.

Text reads and writes support UTF-8 files up to 1 MiB. Binary files, deletion, and renaming are not supported. Writes are applied atomically where applicable, so configure `--root` as narrowly as possible.

## Requirements

- Node.js 20+
- An OpenAI account/workspace with the required developer-mode / Secure MCP Tunnel access
- `tunnel-client` from OpenAI for private connectivity to ChatGPT

## Install locally

```bash
npm install
npm link
```

Then:

```bash
bdxa doctor --root ~/projects
bdxa remote --root ~/projects --port 3333
```

You should see:

```text
Buildifyx Desktop Agent
Root:   /your/path/projects
MCP:    http://127.0.0.1:3333/mcp
Health: http://127.0.0.1:3333/health
Mode:   private / root-scoped read-write-command
```

Check health:

```bash
curl http://127.0.0.1:3333/health
```

## Connect privately to ChatGPT

ChatGPT does not connect directly to localhost MCP servers. For a developer machine or private network, use OpenAI Secure MCP Tunnel.

1. Create a tunnel in OpenAI Platform tunnel settings and get a `tunnel_id`.
2. Download the current `tunnel-client` from OpenAI's tunnel settings / public release.
3. Start this MCP CLI:

```bash
bdxa remote --root ~/projects --port 3333
```

4. Configure the tunnel client to point at the local HTTP MCP endpoint. OpenAI's current tunnel-client docs use `--mcp-server-url` for HTTP servers. Conceptually:

```bash
export CONTROL_PLANE_API_KEY="sk-..."

tunnel-client init \
  --profile buildifyx-local \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --mcp-server-url http://127.0.0.1:3333/mcp

tunnel-client doctor --profile buildifyx-local --explain
tunnel-client run --profile buildifyx-local
```

Use `tunnel-client help quickstart` if the exact CLI flags in your installed version differ.

5. In ChatGPT developer-mode app creation, choose **Tunnel** as the connection type and select/paste the tunnel ID.
6. Scan tools. You should see `get_system_info`, `list_directory`, `read_file`, `write_file`, `edit_file`, and `run_command`.
7. Test with prompts such as:

```text
Use my Buildifyx app and show basic system info.
```

or:

```text
Use my Buildifyx app and list the top-level folders in the allowed root.
```

or:

```text
Use my Buildifyx app to read src/server.js.
```

or:

```text
Use my Buildifyx app to replace line 10 in src/server.js with the text I provide.
```

## Publish later

After this private MVP works, the next step is to split the architecture:

```text
ChatGPT → SaaS Remote MCP → WSS → npm Agent → User PC
```

At that point this package becomes the local Agent rather than the MCP endpoint itself.

## Security notes

- Binds only to `127.0.0.1`.
- Rejects non-local browser `Origin` headers.
- `run_command` does not invoke a shell and only allows explicit executable names.
- File access stays under `--root` after realpath/symlink resolution.
- `.git` internals cannot be listed, read, or edited through file tools.
- Text files are limited to 1 MiB.
- Secure MCP Tunnel is preferred over exposing the local port publicly.
