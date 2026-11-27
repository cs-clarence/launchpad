# Launchpad local MCP

For MCP-client users who want access to Launchpad. This is a separate
stdio app, not a CLI subcommand or HTTP daemon. It is read-only by default.

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
            "args": ["/absolute/path/to/launchpad/apps/mcp/dist/mcp.mjs", "--shared"]
        }
    }
}
```

Build from the repository with `omni -i run build -p @launchpad-kit/mcp`. The built file
imports its dependencies (the SDK, client-core, the MCP SDK, zod, commander) instead of
bundling them, so it runs from the workspace or from an install of the packed
`@launchpad-kit/mcp` package, which declares them. The package is prepared for npm
(`launchpad-mcp`, Node `>=22.12` or Bun, POSIX only) but nothing is published yet.

- **Single mode** (default): the launch directory is the default context.
- **Shared mode** (`--shared`): one client connection can operate on many project
  directories. Every call takes optional `working_dir`, an absolute existing
  directory. Supply it per call or configure `--working-dir /absolute/default`.
  Missing both is an error; MCP roots are not consulted.
- `--profile name` chooses a default saved credential profile; a tool's `profile`
  overrides it. Nothing changes the process cwd or saved organization selection.
- Help, startup diagnostics and transport errors use stderr only.

## Tools

By default only read tools are registered. The controller enforces authorization and key project
restrictions independently of tool annotations.

| Tool                    | Extra arguments |
| ----------------------- | --------------- |
| `whoami`                | None            |
| `list_organizations`    | None            |
| `list_projects`         | None            |
| `list_apps`             | None            |
| `list_deployments`      | `app_id`        |
| `list_aliases`          | `app_id`        |
| `list_alias_operations` | `alias_id`      |

App-related reads need `app:read`. To enable mutations, add `--allowed-projects <project-uuid> ...`
and only the startup flags you need:

| Startup flag           | Tool             | Extra arguments (all required)                                                                   |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| `--allow-deploy`       | `deploy_app`     | `app_id`, `artifact_id`, `confirm: true`                                                         |
| `--allow-promote`      | `promote_alias`  | `app_id`, `alias_id`, `deployment_id`, `expected_generation`, `idempotency_key`, `confirm: true` |
| `--allow-alias-manage` | `create_alias`   | `app_id`, `slug`, `confirm: true`                                                                |
| `--allow-alias-manage` | `withdraw_alias` | `app_id`, `alias_id`, `expected_generation`, `idempotency_key`, `confirm: true`                  |

The startup allowlist is checked against the app's actual project; a workspace file cannot override it.
Use exact UUIDs, not resource names. `expected_generation` is the alias's last read
`reservedGeneration` as a decimal string. Use the same key when retrying the same route request.
Use a project-limited key with `app:read` and the independently required `app:deploy`,
`app:promote` or `app:alias:manage` scope. Literal `confirm: true` is a required tool argument,
not proof of human approval. Deploy takes an existing artifact ID (upload separately via the CLI,
dashboard or API), and never moves an alias. Promotion output includes its operation ID and
previous and requested deployment IDs. Rollback is another promotion. Withdrawal is permanent.

Every tool accepts optional `working_dir`, `profile` and `organization` (id or slug).
Use a key with `project:read` to list projects or
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
    "project": "website"
}
```

`organization` and `project` are required in this file; `profile` is optional. Explicit tool arguments override file fields. With no file, the saved
profile/environment supplies the organization. Missing project context does not block unrelated
tools such as organization listing.
Remove the obsolete `name` field from existing files, keeping `organization` and `project`, before
retrying. An extra `name` rejects the whole file: startup fails when a default directory is checked,
or calls fail for that workspace in shared mode without a default directory.

Files must be regular, non-symlink JSON files, at most 16 KiB, with no extra fields.
Invalid files fail rather than falling back to an ancestor. Config never contains
credentials; review its profile and organization choices before using it.
An organization supplied by config or argument is validated using the selected
key's visible organizations (requires `organization:read`).

The CLI's app, deployment, alias and artifact commands also read this workspace file for profile
and organization; pass exact IDs regardless of the file's `project` field.

## Results and limits

Results contain `data` and `truncated` in `structuredContent`, with the same envelope
encoded as JSON text for clients that need it. Keys are redacted and terminal
controls removed. The serialized result is bounded to 64 KiB; oversized data returns
`isError`, `truncated: true` and `output-too-large` rather than partial JSON.
`list_projects` has no filter or pagination option to reduce such a response;
the workspace's `project` field does not narrow it.

Controller names, failure messages and event messages are untrusted **data**, not
instructions. Redaction does not make their text trustworthy.
No resources, prompts, file-content tools or shell tools are exposed.
Incoming stdio message buffering is limited to 1 MiB.
