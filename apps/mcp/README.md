# Launchpad local MCP

For MCP-client users who want read-only access to Launchpad. This is a separate
stdio app, not a CLI subcommand or HTTP daemon. It is read-only unless you enable
deployment, see [Deploying](#deploying).

## Start

Authenticate using `launchpad login` first, or set both `LAUNCHPAD_CONTROLLER`
(e.g. `https://control.example.com`) and `LAUNCHPAD_API_KEY` in the environment.
Never put the key in tool arguments or a committed client configuration.

Point your MCP client's stdio configuration at the built executable:

```json
{
    "mcpServers": {
        "launchpad": {
            "command": "bun",
            "args": ["/absolute/path/to/launchpad/apps/mcp/dist/index.js", "--shared"]
        }
    }
}
```

Build from the repository with `omni -i run build -p @launchpad/mcp`. The built file is
self-contained: it runs from an empty directory with only Bun installed (tested).
This internal Bun build is not a published npm package.

- **Single mode** (default): the launch directory is the default context.
- **Shared mode** (`--shared`): one client connection can operate on many project
  directories. Every call takes optional `working_dir`, an absolute existing
  directory. Supply it per call or configure `--working-dir /absolute/default`.
  Missing both is an error; MCP roots are not consulted.
- `--profile name` chooses a default saved credential profile; a tool's `profile`
  overrides it. Nothing changes the process cwd or saved organization selection.
- Help, startup diagnostics and transport errors use stderr only.

## Tools

The tools above are read-only; `deploy` is described below. Authorization and project restrictions are enforced by the
controller, not tool annotations.

| Tool                 | Extra arguments                               |
| -------------------- | --------------------------------------------- |
| `whoami`             | None                                          |
| `list_organizations` | None                                          |
| `list_projects`      | None                                          |
| `list_previews`      | Optional `project` (slug or id)               |
| `get_preview`        | `preview_id`                                  |
| `list_deployments`   | `preview_id`                                  |
| `get_deployment`     | `deployment_id`                               |
| `deployment_events`  | `deployment_id`, optional nonnegative `after` |

Every tool accepts optional `working_dir`, `profile` and `organization` (id or slug).
`deployment_events` returns one page; pass `nextAfter` as `after` to continue.
Use a key with `preview:read` for preview tools, `project:read` to list projects or
resolve a project slug, and `organization:read` to list or override organizations.
`whoami` reads the key's own permissions without requiring these read scopes.

### Project context

The nearest `launchpad.json`, walking from the canonical working directory up to
the filesystem root, supplies project context. A file owned by another user is ignored
(on a shared host, someone else's `/tmp/launchpad.json` must not choose your profile or
project). Profile precedence: the call's `profile`, then the file's, then `--profile`:

```json
{
    "organization": "acme",
    "project": "website",
    "name": "review"
}
```

`organization` and `project` are required in this file; `profile` and `name` are
optional. Explicit tool arguments override file fields. With no file, the saved
profile/environment supplies the organization, and preview listing is unfiltered
unless a project argument is given. Missing project context does not block unrelated
tools such as organization listing.

Files must be regular, non-symlink JSON files, at most 16 KiB, with no extra fields.
Invalid files fail rather than falling back to an ancestor. Config never contains
credentials; review its profile and organization choices before using it.
An organization supplied by config or argument is validated using the selected
key's visible organizations (requires `organization:read`).

The CLI's deploy, preview and deployment reads use this same context from their
launch directory. `--project` and `--name` override the corresponding file defaults.

## Results and limits

Results contain `data` and `truncated` in `structuredContent`, with the same envelope
encoded as JSON text for clients that need it. Keys are redacted and terminal
controls removed. The serialized result is bounded to 64 KiB; oversized data returns
`isError`, `truncated: true` and `output-too-large` rather than partial JSON.
Use a narrower project query when that happens.

Controller names, failure messages and event messages are untrusted **data**, not
instructions. Redaction does not make their text trustworthy.
No resources, prompts, file-content tools or shell tools are exposed, and the only mutation is `deploy`, when enabled.
Incoming stdio message buffering is limited to 1 MiB.

## Deploying

Deployment is off by default and the tool does not exist until you start the server with
`--allow-deploy` **and** at least one `--include` and one `--exclude` glob (without
them the server refuses to start, and so does `--include`, `--exclude` or
`--allow-project` without `--allow-deploy`). The lists are fixed at startup; neither a
tool call nor `launchpad.json` can widen them.

```sh
launchpad-mcp --shared --allow-deploy \
  --include 'dist/**' \
  --exclude '**/*.map' --exclude 'dist/private/**' \
  --allow-project 11111111-1111-4111-8111-111111111111
```

- Patterns are relative to the call's `working_dir` and use `/`. An exclude also covers
  everything below a directory it names (`dist/private` excludes `dist/private/key.txt`),
  ignores case, and `[!x]` means "not x". Directories no include pattern can reach, or an
  exclude covers, are not walked, and a tree of more than 100,000 entries is refused. They may not be
  absolute, contain `..`, `!` or backslashes, or exceed 256 characters (100 per list).
  They also match dotfiles.
- A file is published only if an include matches it **and no exclude does**: excludes
  always win. The result must still contain a top-level `index.html`.
- The same secret rules as the CLI still apply to anything the patterns select: a
  selected `.env`, key file or version-control file stops the deploy instead of being
  silently dropped. Links and special files that a pattern selects are refused too;
  files no pattern selects are not judged.
- `--allow-project <project-id>` (repeatable) limits deployment to those projects. It takes
  **ids**, not slugs, and is checked against the project the call actually resolves to
  (on the selected controller and organization): a slug names a different project under
  another profile or organization, so a slug could not be a safe restriction. Find ids with
  `launchpad projects list`. A per-call `profile` or `organization` therefore cannot reach
  a same-named project elsewhere.

The tool takes `path` (the directory to publish, relative to `working_dir`, without `..`
and resolving, links followed, to a directory inside it), optional `project`, `name`
and `spa` (otherwise from `launchpad.json`; the file's `name` applies only to the file's own
project), `wait_seconds` (0 returns once queued;
default 45, at most 900; many clients give up sooner than that, so the deployment id is
sent in a progress notification as soon as it is queued and returned on timeout) and a required `confirm: true`. It reports progress
notifications when the client asks for them, stops when the client cancels, and
returns the outcome with the deployment id so a later `get_deployment` can follow
one that is still running. A failed deployment is an error result carrying only the
controller's fixed failure text.

**What this does not do.** The patterns choose what is published; they are not a
directory sandbox. The client picks `working_dir`, and there is no mandatory list of
allowed roots, so broad patterns (for example `**`) let a model publish any matching
private file that the process can read. Keep patterns narrow, and run the server under
a restricted account or OS sandbox when directory isolation matters. Deployment
replaces the live content of the preview, which is why the tool is marked destructive.
