# Milestone 4: local MCP provides the same safe deployment workflow

Status: **approved by the user with the directory and deployment-policy revisions below**. Extends `docs/plans/application.md`
milestone 4 and `docs/design/application.md` ("CLI and local MCP share a client core").

## Assessment

- **Kind:** medium (one new app, no new server behavior, no schema change).
- **Risk:** High, because an LLM-driven client can read local files and cause
  deployments: archive selection (include/exclude patterns, symlinks), mutation authorization,
  prompt injection through logs/deployed content, and protocol correctness (stdout is
  the protocol).
- **Undo:** revoke the key or disable mutating tools (they are off by default). The
  controller and CLI are untouched; the MCP app has no host or Dokku credentials.
- **Execution:** solo, one PR per slice; independent Opus review of the whole
  milestone at the end (filesystem boundary and authorization especially).

## Outcome

`launchpad-mcp` (stdio) lets an MCP client list organizations, projects, previews,
deployments and progress, and, only when started with deployment enabled, deploy a
directory using an explicitly configured include/exclude policy and follow it to completion. It calls the same
client-core operations as the CLI, with the same profiles, credentials, safe errors,
redaction, idempotency and exit-free structured results.

## Decisions

1. **Package:** `apps/mcp` (`@launchpad/mcp`, binary `launchpad-mcp`), generated with
   the Omni generator, built on the official `@modelcontextprotocol/sdk` (pinned in
   the catalog) with zod schemas. Separate executable only, no CLI subcommand:
   the CLI has no MCP dependency.
2. **Two modes, one stdio server.** _Single_ (default): the context is the directory the
   server was started in unless configured otherwise. _Shared_ (`--shared`): launched
   once for calls concerning any project. Every tool accepts optional `working_dir`;
   when supplied it must be an absolute existing directory and takes precedence over
   the startup default (`--working-dir`). Shared mode has no implicit default: a call
   without either returns a validation error. Relative paths and deployment patterns
   resolve against that call's effective directory. No process-wide `chdir` or mutable
   current-project state: concurrent calls cannot change one another's context.
   Stdio is one client connection; shared mode means multiple project contexts on
   that connection, not a multi-client daemon.
   Do not depend on MCP roots (deprecated in protocol revision `2026-07-28`):
   there is no automatic client-directory fallback.
3. **Context from a directory.** The context of `working_dir` is found by walking up from
   it to the first `launchpad.json`: `{ "profile"?, "organization",
   "project", "name"? }`. It holds no secrets; credentials stay in the shared credential
   store, selected by `profile` (default: the current profile). Explicit tool arguments
   (`organization`, `project`) override the file, and a call with neither fails with a clear
   message. The CLI reads the same file (`launchpad deploy` without `--project`), so both
   clients agree; its schema is validated strictly and has a size limit. No secret is ever a
   tool argument or output.
4. **Read-only by default.** Read tools: `whoami`, `list_organizations` (backed by
   client-core's `listOrganizations`), `list_projects`, `list_previews`,
   `get_preview`, `list_deployments` (via preview), `get_deployment`,
   `deployment_events`. Mutating tools (`deploy`) exist only with `--allow-deploy`.
   Tool annotations are hints only; enforcement is the startup flag plus the key's scopes
   plus the controller.
5. **Deployment file policy:** `--allow-deploy` requires explicitly supplied, nonempty
   `--include` and `--exclude` lists (repeatable flags); missing either is a startup
   error, in either mode. Patterns are relative to each call's effective `working_dir`,
   not the server's launch directory or the deployment source. Only included files
   that match no exclusion may enter the archive: **exclude always takes precedence**.
   The policy is fixed at startup and cannot be broadened through tool arguments or
   `launchpad.json`. No mandatory `--root` flag or MCP-roots lookup.
   Patterns use normalized, directory-relative paths; reject absolute patterns and
   parent traversal. The deploy source must be a directory within `working_dir`;
   reject symlinks rather than following them around the selection policy. Preserve
   existing secret/dotfile exclusions as additional mandatory exclusions, plus archive
   limits and the required `index.html`. Empty or invalid selected sites fail before
   upload. No tool reads file contents back; no shell tool. This policy controls what
   is published, not OS-level filesystem access: the process runs with its user's
   permissions.
   **Accepted trust trade-off:** the client chooses `working_dir`. With broad patterns,
   matching private files in any readable directory can be published; neither the
   source-within-directory check nor the destination project allow-list prevents this.
   The user explicitly chose this policy over mandatory startup-authorized roots.
   Startup help and the MCP README must warn about that authority and recommend narrow
   patterns plus an OS sandbox/restricted account if directory isolation is needed.
6. **Mutation authorization:** `--allow-deploy` is the explicit policy. A deploy call also
   needs `confirm: true` and, to bound blast radius, only names matching the CLI's slug
   rule; `--allow-project <id|slug>` (repeatable, optional) limits which projects may be
   deployed to. Deletion and logs tools are not offered (milestone 5 / not built).
7. **Output:** structured JSON content bounded (e.g. 64 KiB, truncated with a flag),
   text from the controller (failure messages, event messages) is returned as data inside
   a field, never as instructions, passed through the existing redaction/control-char
   stripping. Diagnostics go to stderr only; stdout carries protocol messages only
   (a test asserts nothing else is written).
8. **Idempotency/waiting:** `deploy` reuses client-core `deploy`, with a bounded wait
   (default 10 min, tool argument capped) and progress notifications; on timeout it
   returns the deployment id so a later `get_deployment` call can follow it.

## Slices (one PR each)

1. **Package and read-only server:** generator scaffold, startup (mode, default working
   directory), per-call `working_dir` resolution, `launchpad.json`
   context resolution (shared with the CLI via client-core),
   stdio transport, read tools, bounded/redacted output, unit tests with an in-memory
   MCP client transport, stdout-purity test.
2. **Deploy tool:** include/exclude filtering in the shared client-core packer
   (existing CLI defaults unchanged), `--allow-deploy`, `confirm`, project
   allow-list, progress, tests for escape attempts (symlink, `..`, source outside
   `working_dir`, file not directory), include/exclude overlap (exclude wins),
   mandatory startup lists, excluded `index.html`, missing/insufficient scopes, malicious
   event text, oversized output.
3. **End to end and docs:** a real MCP client (the SDK's client over stdio against the
   built binary and the real built controller) lists, deploys the fixture (deployments
   run against the fake worker ports used by the existing client e2e) and tracks
   completion; `apps/mcp/README.md` with client config examples using `example.com` and
   no secrets; docs/patterns and tooling updates; packaging check that the build runs
   without the monorepo (as the CLI does).
4. **Milestone Opus review** and fixes.

## Verify

Shared mode: two project directories served by one process without leaking context
between calls; explicit directory overrides the startup default; missing both in shared
mode is refused; relative paths and patterns use the effective `working_dir`.
An excluded file never enters an archive even if included, and a tool call cannot
broaden the startup policy. No MCP-roots capability is required.
A real MCP client lists, deploys the fixture and tracks completion; escape and
read-boundary tests; scope tests (a read key cannot deploy, a deploy tool with a
read-only key returns a safe error); protocol correctness; output bounds.

## Not in this milestone

Deletion tools (after milestone 5), log tools (no log endpoint yet), HTTP/remote MCP,
resources/prompts, browser login.

## Progress

- Slice 1 implemented: separate read-only stdio app; eight read tools; shared-mode
  `working_dir` with optional startup default; strict, bounded `launchpad.json`
  resolution shared with CLI deploy; per-call contexts without saved-state mutation;
  redacted, bounded JSON results. Tests exercise real MCP client/server transports,
  concurrent project contexts, stdio purity, permission errors, invalid config and
  CLI file defaults. Deployment flags/tools remain unavailable until slice 2.
- Slice 2 implemented: `--allow-deploy` with mandatory include/exclude lists (exclude wins,
  pattern validation, fixed at startup), the `deploy` tool (`confirm`, project allow-list,
  path confined to `working_dir`, progress and cancellation), and the selection in the
  shared packer (`picomatch`, pinned in the catalog). Selected secrets and links are still
  refused; unselected files are not judged.
