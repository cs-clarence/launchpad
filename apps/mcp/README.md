# Launchpad local MCP

For MCP-client users who want read-only access to Launchpad. This is a separate
stdio app, not a CLI subcommand or HTTP daemon. Deployment is not available yet.

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

Build from the repository with `omni -i run build -p @launchpad/mcp`.
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

All tools are read-only. Authorization and project restrictions are enforced by the
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
the filesystem root, supplies project context:

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

The CLI's `deploy` uses this same context from its launch directory. `--project`
and `--name` override the corresponding file defaults.

## Results and limits

Results contain `data` and `truncated` in `structuredContent`, with the same envelope
encoded as JSON text for clients that need it. Keys are redacted and terminal
controls removed. The serialized result is bounded to 64 KiB; oversized data returns
`isError`, `truncated: true` and `output-too-large` rather than partial JSON.
Use a narrower project query when that happens.

Controller names, failure messages and event messages are untrusted **data**, not
instructions. Redaction does not make their text trustworthy.
No resources, prompts, file-content tools, shell tools or mutation tools are exposed.
Incoming stdio message buffering is limited to 64 KiB.

## Planned deployment policy

Slice 2 will add deploy only when enabled at startup with explicit include and
exclude lists; excludes always win. These options are currently rejected.
There is no mandatory root list: with deployment enabled, a client-selected directory
and broad patterns can publish matching private files anywhere the process can read.
Use narrow patterns and an OS sandbox or restricted account when directory isolation
is required. File-selection patterns are not an OS sandbox.
