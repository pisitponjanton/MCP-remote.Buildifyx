# Command consent and permission independence

Status: implemented in this checkout, 2026-10-20. Base: `fd494b8`.

## Problem

Command policy and execution restrictions made separate decisions. For example,
`command=allow` admitted `rg --files` to the service, which then rejected the
executable without asking. Full Access unlocked that service only when all five
base permissions were Allow. Package installation, script execution and deletion
also shared a generic destructive-action explanation.

## Decision

- One operation evaluation classifies argv and determines its required categories.
  Explicit Deny in any required category wins over remembered Allow rules.
  Command permission is always required. Dependency installs also require write;
  automatic ripgrep reads require read. Multiple operation Ask categories share
  one approval. Outside-directory consent remains a separate gate.
- Retain the existing `dangerous` policy key and the 16-category protocol. It
  controls sensitive/unclassified command consent, with specific explanations
  for dependency installation, project code, repository changes and deletion.
  Install/build are not automatically allowed or described as harmless.
- Unknown executables/argv request consent under that policy instead of failing
  at an independent executable allowlist. A completed authorization is bound to
  executable, argv and canonical cwd and checked again before spawn. It does not
  require unrelated read/write/outsideRoot Allow settings.
- The existing explicit `--unrestricted-commands` host-execution opt-in remains
  compatible for unclassified executable names. Known sensitive operations and
  explicit category denials still go through policy.
- Automatic `rg --files` and `rg --version` accept exactly those argument shapes.
  Execution inserts `--no-config`; flags, helpers, paths and other patterns need
  consent. This avoids importing hostile RIPGREP_CONFIG_PATH settings into the
  automatic path. Ordinary `git --version` no longer needs sensitive consent.
- New remembered approvals store `exact: true` and canonical `cwd` alongside the
  existing executable/argsPrefix/action fields. Changing arguments or directory
  requires a new approval. Store updates and removal distinguish scoped rules.
  Existing manually configured/persisted prefix rules remain readable, but an
  Allow prefix cannot extend to additional arguments for sensitive operations.
- Recheck relevant command/category/rule and directory authorization before
  spawning. Pending consent cannot authorize a command after a relevant policy
  change. Cancellation and request replay protection remain in the runtime.
- Public failures contain only whitelisted category, operationClass, gate and
  nextAction values. Local MCP preserves these diagnostics through IPC; Cloud
  Agent responses use the same sanitizer. No argv/path is added to public errors.
- Run Windows npm via node.exe and the installed npm-cli.js, keeping shell:false.
  Release qualification and runtime execution share this resolver.

## Boundaries

This change fixes consent and policy coupling. Commands still execute on the
host as the user. cwd validation is not filesystem confinement; arbitrary project
code can access host resources granted to the OS user. There is no new OS sandbox,
network/secret isolation, script-content trust, expiring task grant or process
termination on policy revocation after spawn. Existing cancel/timeout can stop
processes. Remembered commands persist per instance until removed; an exact
command can execute different project code after that project's files change.
Choose Allow once when that continuing trust is not intended.

The existing Git/package-query classifiers are retained rather than claimed as
complete proofs of side-effect freedom. General safe shell parsing, flags/path
analysis, broad executable auto-allow and cross-platform OS isolation are not
introduced. Native Windows/Linux execution still needs their CI runners.

## Validation

`npm run verify:permissions` runs disposable offline fixtures and prints outcomes.
`npm test` covers policy, consent lifecycle, scripts, cancellation, stored rules,
hostile ripgrep config, actual Local MCP and a loopback Cloud Agent WebSocket.
See [measured results](permission-validation.md). These are correctness checks,
not performance benchmarks or a production Cloud authentication test.
