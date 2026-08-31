# Buildifyx Desktop Agent MVP

Buildifyx Desktop Agent is a private local MCP agent that lets ChatGPT work with a user-selected project directory.

```text
ChatGPT
  ↓
Secure MCP connection
  ↓
bdxa remote
  ↓
Local runtime
  ↓
User machine
```

Current version: `@buildifyx/desktop-agent@0.1.0`

## CLI

```bash
bdxa
bdxa remote --root ~/projects
bdxa doctor --root ~/projects
bdxa update
bdxa --version
```

`bdxa` with no command starts remote mode in restricted command mode.

## Tools

- `get_system_info`
- `list_directory`
- `read_file`
- `write_file`
- `edit_file`
- `run_command`

File tools are strictly scoped to the configured root. Path traversal, symlink escape, and `.git` internals are rejected. Text files are limited to 1 MiB.

## Command security

`run_command` uses `execFile`, `shell: false`, bounded timeout/output, and a `cwd` that must resolve inside the configured root.

This is not an OS sandbox. `--root` scopes file tools and command working directory, but a spawned program can still access resources available to the current OS user.

### Restricted mode

Default:

```bash
bdxa remote --root ~/projects
```

Allows the reduced command set used for common developer workflows (`git`, `npm`, `pnpm`, `yarn`) and blocks direct runtimes/package executors such as `node`, `python`, `npx`, `bun`, `deno`, `pip`, `npm exec`, and `pnpm dlx`.

Restricted mode reduces the execution surface but is still not a sandbox; package scripts can execute project code.

### Full access mode

```bash
bdxa remote --root ~/projects --full-access
```

Full access enables the configured runtime/package-executor commands and prints an explicit warning.

## Modular architecture

All tools now use one execution path:

```text
MCP transport
     ↓
Core runtime
     ↓
Dispatcher
     ↓
Permission policy
     ↓
Services
     ↓
OS / filesystem
```

Project structure:

```text
src/
├─ cli.js                         # npm bin entrypoint only
├─ server.js                      # compatibility export
├─ version.js                     # package/update metadata
│
├─ cli/
│  ├─ main.js                     # CLI routing
│  ├─ help.js                     # help output
│  ├─ options.js                  # option parsing/validation
│  └─ commands/
│     ├─ remote.js
│     ├─ doctor.js
│     └─ update.js
│
├─ core/
│  ├─ runtime.js                  # composes the local runtime
│  ├─ dispatcher.js               # single tool dispatch entrypoint
│  ├─ permissions.js              # read/write/command policy
│  └─ errors.js                   # typed agent errors
│
├─ services/
│  ├─ index.js                    # service composition
│  ├─ system.js                   # system execution logic
│  ├─ files.js                    # file execution logic
│  └─ commands.js                 # command execution logic
│
├─ transport/
│  └─ mcp/
│     ├─ server.js                # HTTP/MCP transport
│     ├─ response.js              # core result/error → MCP response
│     └─ tools/
│        ├─ index.js
│        ├─ system.js
│        ├─ files.js
│        └─ commands.js
│
├─ security/
│  └─ path.js                     # root/path boundary
│
└─ utils/
   └─ text.js                     # UTF-8/text editing primitives
```

The important rule is that MCP modules do not execute OS operations directly. They validate/describe the MCP tool and call the shared dispatcher. A future WebSocket transport can call the same runtime without duplicating file or command logic.

## Permission model

Permissions currently support:

```text
allow
confirm
deny
```

Tool categories:

```text
get_system_info → read
list_directory  → read
read_file       → read
write_file      → write
edit_file       → write
run_command     → command
```

`confirm` currently produces a typed `CONFIRMATION_REQUIRED` error. This intentionally keeps confirmation UI outside the core so a future ChatGPT/SaaS transport can decide how confirmation is presented.

Typed core errors include codes such as:

```text
TOOL_NOT_FOUND
PERMISSION_DENIED
CONFIRMATION_REQUIRED
COMMAND_NOT_ALLOWED
PATH_OUTSIDE_ROOT
FILE_TOO_LARGE
INTERNAL_ERROR
```

MCP error responses preserve these codes in `structuredContent` rather than requiring clients to parse human-readable strings.

## Requirements

- Node.js 20+
- Access to the MCP/tunnel connection used for local development

## Local development

```bash
npm install
npm link
bdxa doctor --root ~/projects
bdxa remote --root ~/projects --port 3333
```

Example startup:

```text
Buildifyx Desktop Agent
Version: 0.1.0
Root:    /your/path/projects
MCP:     http://127.0.0.1:3333/mcp
Health:  http://127.0.0.1:3333/health
Mode:    restricted
```

Health:

```bash
curl http://127.0.0.1:3333/health
```

## Tests and checks

```bash
npm run check
npm test
npm pack --dry-run
```

`npm run check` recursively syntax-checks all JavaScript under `src/` and `scripts/`, so adding a module does not require manually editing the check command.

Current tests cover runtime dispatch, typed permission/errors, file/path behavior, command security policy/execution, MCP response adaptation/origin policy, and version comparison.

## Next step

The local execution core is now transport-independent. The next major layer can be added without rewriting the tools:

```text
ChatGPT
   ↓
Buildifyx SaaS Remote MCP
   ↓
WebSocket relay
   ↓
bdxa WebSocket transport
   ↓
Core runtime / dispatcher
   ↓
Permissions
   ↓
Services
   ↓
User PC
```

Before production SaaS use, command execution still needs a stronger product-level confirmation/audit model and should not be described as sandboxed.
