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
launchpad artifact upload <project-id> <archive-or-directory> [--directory]
launchpad app list | create <project-id> <slug>
launchpad app deploy <app-id> --artifact <id> [--spa] [--ttl <duration>]
launchpad app deployments <app-id> | shutdown <app-id> --confirm
launchpad deployment get <id> | events <id> [--after <sequence>] | delete <id> --confirm
launchpad alias list <app-id> | create <app-id> <slug> | operations <id>
launchpad alias promote <alias-id> <deployment-id> --expected-generation <generation> --idempotency-key <key> --confirm
launchpad alias withdraw <alias-id> --expected-generation <generation> --idempotency-key <key> --confirm
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
  7 and 8 are reserved. Queuing a deployment or routing operation exits successfully; check status separately.

## Workspace file

App, deployment, alias and artifact commands read the nearest `launchpad.json` for profile and
organization context (see [workspace resolution](../mcp/README.md#project-context)). An explicit
`--profile` wins. Pass exact IDs for the affected project or resource; a workspace file's `project`
does not select a mutation target. Other CLI commands use the saved profile or environment.

The old `deploy`, `previews` and `deployments` commands are gone. `app deploy` queues an immutable
deployment and does not promote it. Roll back via `alias promote` with an older retained deployment.
Reuse the same idempotency key and generation for a retry of the exact same routing request.
See the [deployment walkthrough](../../docs/deployments.md). The old `name` field of `launchpad.json`
is no longer accepted.

- Output and errors hide anything shaped like a key and strip terminal escape
  sequences/control bytes. Serialized JSON stays valid.
- If the credential store reports `store-busy` (exit 6), wait for other commands
  to finish and retry. After a crashed writer, remove `credentials.json.lock`
  only after confirming no client is writing. Locks are never stolen by age.

`src/program.ts` holds the commands behind an `Io` interface (`src/io.ts`), so tests drive `run(argv, io)` with a
fake terminal, a temporary config directory and a fake controller. `src/index.ts` is the Bun entry point.

Build and check commands are in [CONTRIBUTING.md](../../CONTRIBUTING.md).
