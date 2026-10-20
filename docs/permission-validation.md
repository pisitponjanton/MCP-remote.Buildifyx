# Command permission verification — 2026-10-20

Source baseline: Agent commit `fd494b8`. Current result: working-tree changes in
this checkout, not a published package. Host: macOS arm64, Node v26.0.0.

## Method

Ran the same 22-case runtime fixture against the original source extracted with
`git archive HEAD`, then against the changed source. Fixtures are disposable,
have no remote dependencies, use offline npm and private fixture config/cache,
and are removed after each run. No real global install, destructive command or
production service was exercised. All attempted deletions/global installs in the
matrix are rejected cases. The fixture's postinstall only writes a local marker.

The original source met 10/22 expectations in the new independent rubric; the
changed source met 22/22. This is a permission correctness count, not task success
rate, latency, a statistically sampled benchmark, or an assertion of complete
security coverage. Each row is one scenario, not repeated performance samples.

Raw sanitized outcomes, prompts and expected values:
[permission-matrix-2026-10-20.json](evidence/permission-matrix-2026-10-20.json).

## Results

| Command / configuration | Before | After | Reason |
|---|---|---|---|
| `git --version`; sensitive/write/outsideRoot Deny | Permission denied | Completes, no prompt | Version query does not need unrelated categories |
| `rg --files`; read/command Allow; other base categories Deny | Execution allowlist rejects | Completes, no prompt | Exact read operation; config disabled |
| `rg --files`; read Deny | Generic executable rejection | Read permission denied | Relevant Deny is enforced |
| `npm install` in offline empty fixture; approve once | Completes | Completes, one approval | Consent permits the invocation; fixture postinstall marker exists |
| Same install with `--ignore-scripts` | Completes | Completes, one approval | Fixture postinstall marker does not exist |
| Install; user rejects | Denied | Denied | No script runs |
| Install; no interactive approver | Confirmation required | Confirmation required | Attach an approver; no automatic escalation |
| Install; command or write Deny; sensitive Allow | **Runs despite Deny** | Denied before spawn | Required category Deny takes priority |
| Install; sensitive Deny plus exact Allow rule | **Runs despite Deny** | Denied before spawn | A command rule cannot override a required category Deny |
| `npm run build`; approve once | Completes | Completes, one approval | Explicit project-code execution consent |
| `node --version`; approve once | Execution allowlist rejects without asking | Completes, one approval | Unknown command gets actionable scoped consent |
| `node --version`; reject / no approver | Generic execution rejection | Permission denied / confirmation required | Correct distinction between policy and missing consent |
| `node --version`; exact remembered rule | Completes | Completes, no prompt | Matching operation grant |
| Command cwd outside roots; outsideRoot Deny | Denied | Denied | Independent directory gate |
| `rm sentinel.txt`; reject | Denied | Denied | Sentinel remains unchanged |
| `rg --pre node needle`; reject | Generic execution rejection | Permission denied | Helper-capable shape needs consent |
| `npm install --global`; only a prefix Allow rule, user rejects | Denied | Denied | Prefix cannot extend a sensitive-operation grant |
| Executable `/bin/sh` | Invalid input | Invalid input | Executable paths are not accepted |
| Executable string `npm --version && node --version` | Generic execution rejection | Invalid input | Shell command strings are not executable names |
| Nonexistent executable; approve | Generic execution rejection | Command not found | Authorization succeeded; missing binary is an execution failure |

## Other checks

- Consent regression tests verify Allow once is not remembered, new remembered
  rules survive reload with exact argv/canonical cwd, changed args/directory ask
  again, and removed rules or revoked permission/root cannot authorize spawn.
- Automatic ripgrep ignores an injected `--follow` config and does not enumerate
  the fixture's symlink to an external directory. `--follow` itself is not an
  automatically allowed shape.
- A real Local MCP HTTP request through the gateway and detached instance passed
  query/Ask-once/Deny/diagnostic checks without Full Access.
- A real loopback Agent WebSocket passed query/remembered exact approval/Deny
  checks. This is the Agent transport with a mock Cloud peer, not a production
  Cloud deployment or an authenticated browser-client end-to-end test.
- The 29-file permission/core/service/transport/TUI/npm-resolver regression set
  passed on Node v26.0.0. The Local CLI file passed 13/14 tests, including the new
  permission integration case. Its existing Browser Tools smoke failed with
  `BROWSER_LAUNCH_FAILED`: the matching Playwright Chromium executable is absent
  on this host. A complete repository suite is therefore not claimed as passing.
- Source syntax checks passed for 100 JavaScript files. Package dry-run passed
  with 108 included files. The package gate initially exposed its pre-existing
  missing `v0.4.0-integration-tests.md`; that required status document now exists
  with measured results and limits, rather than weakening the package check.
- Native Windows npm resolver behavior is covered by mocked platform tests;
  native Windows/Linux execution was not performed on this macOS host.

## Re-run

```bash
npm run verify:permissions
npm test -- test/permissions/*.test.js test/services/*.test.js test/core/*.test.js test/transport/*.test.js test/release/npm-invocation.test.js test/tui*.test.js
npm test -- test/cli/local.test.js
npm run check
npm run pack:check
```

The transport/Local CLI tests need permission to create local sockets. The last
CLI browser smoke needs the matching explicitly installed Chromium. No browser
download, publish, deployment, global bdxa update or real user policy change is
part of this work. Commands remain unsandboxed host processes; see the
[consent ADR](adr-command-consent.md) for grant and isolation limits.
