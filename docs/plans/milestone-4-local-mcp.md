# Milestone 4: local MCP provides the same safe deployment workflow

Status: **proposed, awaiting the user's approval**. Extends `docs/plans/application.md`
milestone 4 and `docs/design/application.md` ("CLI and local MCP share a client core").

## Assessment

- **Kind:** medium (one new app, no new server behavior, no schema change).
- **Risk:** High, because an LLM-driven client can read local files and cause
  deployments: the filesystem boundary (roots, symlinks), mutation authorization,
  prompt injection through logs/deployed content, and protocol correctness (stdout is
  the protocol).
- **Undo:** revoke the key or disable mutating tools (they are off by default). The
  controller and CLI are untouched; the MCP app has no host or Dokku credentials.
- **Execution:** solo, one PR per slice; independent Opus review of the whole
  milestone at the end (filesystem boundary and authorization especially).

## Outcome

`launchpad-mcp` (stdio) lets an MCP client list organizations, projects, previews,
deployments and progress, and, only when started with deployment enabled, deploy a
directory under an allowed root and follow it to completion. It calls the same
client-core operations as the CLI, with the same profiles, credentials, safe errors,
redaction, idempotency and exit-free structured results.

## Decisions to approve

1. **Package:** `apps/mcp` (`@launchpad/mcp`, binary `launchpad-mcp`), generated with
   the Omni generator, built on the official `@modelcontextprotocol/sdk` (pinned in
   the catalog) with zod schemas. The CLI also gains `launchpad mcp` only if you want
   it; the design shows it, the milestone says "executable". Proposal: separate
   executable only, no CLI subcommand, so the CLI has no MCP dependency.
2. **Two modes, one stdio server.** *Single* (default): the context is the directory the
   server was started in. *Shared* (`--shared`): launched once, no organization, project
   or directory is fixed at startup; **every tool takes a required `current_dir`** and
   works in the context of that directory, so one server can serve any project (several
   clients or several projects of one client). Nothing is remembered between calls.
3. **Context from a directory.** The context of `current_dir` is found by walking up from
   it (never above a `--root`) to the first `launchpad.json`: `{ "profile"?, "organization",
   "project", "name"? }`. It holds no secrets; credentials stay in the shared credential
   store, selected by `profile` (default: the current profile). Explicit tool arguments
   (`organization`, `project`) override the file, and a call with neither fails with a clear
   message. The CLI reads the same file (`launchpad deploy` without `--project`), so both
   clients agree; its schema is validated strictly and has a size limit. No secret is ever a
   tool argument or output.
4. **Read-only by default.** Read tools: `whoami`, `list_projects`, `list_previews`,
   `get_preview`, `list_deployments` (via preview), `get_deployment`,
   `deployment_events`. Mutating tools (`deploy`) exist only with `--allow-deploy`.
   Tool annotations are hints only; enforcement is the startup flag plus the key's scopes
   plus the controller.
5. **Filesystem:** `current_dir` and `deploy`'s `path` (relative to `current_dir`); it must resolve (realpath) inside one of the
   `--root` directories given at startup (at least one required for deploy; none means
   no deploy tool; in shared mode `--root` is the ceiling for every `current_dir`, and
   `current_dir` outside it is refused for every tool, reads included). Roots are
   canonicalized at startup; each path is canonicalized per call; symlink escape, `..`, and non-directories are refused. No tool reads file
   contents back; no shell tool. Same client-side preflight (secret/dotfile exclusion)
   as the CLI, server remains authoritative.
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

1. **Package and read-only server:** generator scaffold, startup (mode, roots), `launchpad.json`
   context resolution (shared with the CLI via client-core),
   stdio transport, read tools, bounded/redacted output, unit tests with an in-memory
   MCP client transport, stdout-purity test.
2. **Deploy tool:** root/symlink enforcement, `--allow-deploy`, `confirm`, project
   allow-list, progress, tests for escape attempts (symlink, `..`, outside root, file
   not directory, root itself a symlink), missing/insufficient scopes, malicious
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
between calls; a `current_dir` outside the roots, a missing one, and a `launchpad.json` outside
the ceiling are refused. A real MCP client lists, deploys the fixture and tracks completion; escape and
read-boundary tests; scope tests (a read key cannot deploy, a deploy tool with a
read-only key returns a safe error); protocol correctness; output bounds.

## Not in this milestone

Deletion tools (after milestone 5), log tools (no log endpoint yet), HTTP/remote MCP,
resources/prompts, browser login.
