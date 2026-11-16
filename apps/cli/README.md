# CLI

The `launchpad` command talks to a controller with an organization API key. It never
talks to Dokku. Keep this page current when commands change.

```text
launchpad login --controller <url> [--profile <name>] [--key-file <path> | --key-stdin]
launchpad logout
launchpad whoami
launchpad profile list | use <name>
launchpad org list | use <slug-or-id>
launchpad projects list
launchpad deploy <directory|archive.tar.gz> [--project <slug|id>] [--name <name>] [--spa] [--no-wait] [--timeout <seconds>]
launchpad previews list [--project <slug|id>] | get <previewId>
launchpad deployments status <deploymentId> [--organization <slug|id>]
launchpad deployments events <deploymentId> [--after <seq>] [--organization <slug|id>]
```

Global options: `--json` (machine-readable output; errors become `{"error":{"code","message"}}` on stderr)
and `--profile <name>`.

- **The key is never an argument.** `login` reads it from `--key-file`, `--key-stdin`, or a hidden terminal
  prompt, so it does not end up in shell history or the process list. Without a terminal and without one of
  those options, it fails. `login` checks the key with the controller before saving it, and selects the
  key's organization.
  `--key-stdin` requires redirected input; with a terminal, omit it to use the hidden
  prompt. File and stdin reads stop at 4096 bytes, even when a device reports size zero.
- **Credentials** live in `~/.config/launchpad/credentials.json` (mode 600; see `packages/client-core`).
  For CI, set `LAUNCHPAD_CONTROLLER` and `LAUNCHPAD_API_KEY` (and optionally `LAUNCHPAD_ORG`) instead; the
  file is not touched. Set both credential variables or neither; a partial pair is
  rejected unless `--profile` explicitly chooses saved credentials. `LAUNCHPAD_ORG`
  is an organization **ID**, not a slug. Without it, project listing discovers
  the key's organization.
- **Exit codes:** 0 success, 1 other failure, 2 usage, 3 not logged in or the key is rejected (401/403),
  4 not found, 5 controller unreachable, timed out or unexpected answer, 6 credential file or profile unusable,
  7 the deployment failed, was cancelled or needs an administrator, 8 `deploy` was still running when `--timeout`
  ran out (it is not cancelled).

## Deploying

`deploy`, `previews` and `deployments` read the nearest `launchpad.json` from their
working directory upward.
The file requires `organization` (id or slug) and `project` (id or slug), with
optional `profile` and preview `name`. `--profile`, `--project` and `--name` override
file values; without file defaults, project and name must be supplied as flags.
Files are strictly validated, bounded to 16 KiB and must not be symlinks.
Organization selection from the file requires `organization:read`; it is checked
against the key's organizations and never saved. With no file, existing
profile/environment behavior is unchanged. This resolver is shared with the
[separate MCP app](../mcp/README.md).
Deployment status/events accept `--organization` to override the file selection.
Queued/timeout follow-up commands include the workspace organization and selected
profile when present, so they do not depend on the original working directory.

`launchpad deploy ./dist --project site --name review` packs the directory, uploads it, finds or creates the
preview named `review` in that project, queues a deployment and follows it until it is live (`--no-wait`
returns once it is queued). Progress goes to stderr; stdout is the result, a single JSON document with `--json`.

- **The directory is checked before anything is sent:** it must have an `index.html` at its top level, and
  links, special files, `.env*`, `.git`, private keys and similar are refused (remove them; nothing is skipped
  silently). The controller validates the archive again and is the authority. An existing `.tar.gz` is sent as
  it is. The limits (50 MiB, 5000 files, 16 levels) match the controller's defaults.
- **Safe to repeat:** a request that got no answer is retried (up to three times) with the same idempotency key,
  so the controller returns the first result instead of deploying twice. A preview takes one deployment at a
  time: deploying while one is unfinished is a conflict (exit 1, code `conflict`).
- **The key needs** `preview:read`, `preview:create` and `preview:deploy` (a project-limited key reaches only its
  projects), plus `project:read` only to name a project by slug (a project id needs no lookup). Previews and deployments are available only when
  the controller has deployments turned on.
- **Failures** carry fixed, safe text (for example, the new release did not become ready and the previous one
  was restored). `reconciliation-needed` means an administrator must check the host, then record the outcome in the dashboard (the preview page) or with `POST …/deployments/{id}/resolution`; until then the preview takes no new deployment.
- **Stored archives** are not deleted yet and each organization may hold `LAUNCHPAD_MAX_ARTIFACTS` (20 by default); `deploy` settles the preview before it uploads so a deploy that cannot start does not spend one. Uploads are refused while deployments are off, and at most 2 per organization run at once.
- Output and errors hide anything shaped like a key and strip terminal escape
  sequences/control bytes. Serialized JSON stays valid.
- If the credential store reports `store-busy` (exit 6), wait for other commands
  to finish and retry. After a crashed writer, remove `credentials.json.lock`
  only after confirming no client is writing. Locks are never stolen by age.

`src/program.ts` holds the commands behind an `Io` interface (`src/io.ts`), so tests drive `run(argv, io)` with a
fake terminal, a temporary config directory and a fake controller. `src/index.ts` is the Bun entry point.

Build and check commands are in [CONTRIBUTING.md](../../CONTRIBUTING.md).
