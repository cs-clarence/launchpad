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
launchpad api <endpoint> [-X <method>] [-f|-F <key=value>]... [--input <file>] [-H <name:value>]... [-i] [--silent] [-q <jq-expression>] [--verbose] [--paginate [--slurp]] [--idempotency-key <key>] [--confirm]
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

## `launchpad api`

`launchpad api <endpoint>` calls any `/api/v1` endpoint with the current profile (or
`LAUNCHPAD_CONTROLLER` and `LAUNCHPAD_API_KEY`) and prints the response. It is modeled on
`gh api`; the endpoints and their fields follow the controller's OpenAPI document (see the
[controller README](../controller/README.md#api-reference)) and may change. An API key
reaches only the endpoints a key may use; the session-only routes (organization, member,
invitation and key creation) answer 401 or 403.

```sh
launchpad api key
launchpad api organizations/{org}/projects -f name=Demo -f slug=demo --confirm
launchpad api -X POST organizations/{org}/projects --input body.json --confirm
launchpad api organizations/{org}/deployments/<id>/events -X GET -F after=12 -F limit=500
launchpad api organizations/{org}/apps -X GET -F limit=50 --paginate
```

- **Method and fields.** `-X` defaults to `GET`, or `POST` when `-f`/`-F` or `--input` is given.
  `-f key=value` is a string, `-F` converts `true`, `false`, `null` and integers and reads
  `@file` or `@-` (stdin). `a[b]=c` nests, `a[]=x` builds an array, a bare `a[]` is an empty
  array. Fields are the JSON body; with `GET`/`HEAD`, or with `--input`, they become the query
  string. `--input <file>|-` sends a JSON body (1 MiB at most; use `-H content-type:...` for
  another type). Standard input can be read once.
- **Placeholders.** `{org}` (the selected organization, as other commands choose it) and
  `{project}` (the nearest `launchpad.json`) are filled in the endpoint and in field values.
  The endpoint value is encoded as one path segment. A placeholder with no value is a usage error.
  `{project}` never makes a change allowed by itself: a non-`GET` still needs `--confirm`.
- **Output.** The body is printed (JSON is pretty-printed), `-i` first prints the status line
  and headers, `--silent` prints no body, `--verbose` prints the request (before it is sent, so it also shows for a failed request) and the response headers
  to stderr. The key and `Set-Cookie` are never shown. Terminal escape sequences and control
  characters are stripped.
- **Paging.** `--paginate` (`GET` only) follows `Link: rel="next"` for a list and prints the
  merged array; `--slurp` prints an array of the pages instead. A link is followed only if it
  is on the controller's origin and names the same `/api/v1` path, so the key is never sent
  elsewhere; at most 1000 pages, 100000 items and 16 MiB are collected, within an overall deadline of 5 minutes (exit 5). Pass `-F limit=<n>` to page
  (without it a list is returned whole). Events keep `after` and `limit`. `--paginate` cannot be
  combined with `-i`.
- **Filtering.** `-q, --jq <expression>` filters a JSON response; strings print raw and
  other values as indented JSON. It uses the system `jq` when one is on `PATH`
  (run without a shell and without your environment, expression as an argument, 10 s and
  8 MiB limits; the filter is also run once on `null` to check it, so any filter that cannot finish on
  `null` within the timeout, such as `input`, `repeat` or `[range(1e9)]`, is refused before the
  request, and jq's own memory use is not limited), otherwise a built-in subset (`@elastic/micro-jq`), so advanced filters
  (`map`, `select` with complex logic, `@csv` and others) may work only with the system `jq`.
  The built-in engine returns one value, so it prints a stream such as `.[].slug` one
  result per line only when the expression has an iterator (`[]` after a path) and does not
  start with `[`; a stream in an expression that also builds values (`{a: .[].x}`) may differ. With
  `--paginate` the filter sees the merged array (or the array of pages with `--slurp`).
  An invalid expression is refused before the request (exit 2); `--verbose` names the engine. If the filter fails after the request was sent (a runtime error
  on the response), the request is not undone: the message says so and the exit code is 1.
- **Files.** `--input` and `-F k=@file` read regular files only (a FIFO is refused without
  opening it) and refuse paths inside the credential store and, on Linux, under `/proc` and
  `/sys` (which can expose the process environment). A hard link to the store's files
  is not detected, and a symlink swapped between the path check and the open is not guarded
  against (it would need write access to your own directories).
- **Idempotency.** `--idempotency-key <key>` sends the `Idempotency-Key` header, checked as in
  `alias promote`.

Differences from `gh api`:

- The endpoint is a path under `/api/v1` only. Full URLs, `//host`, `..`, `#`, `\` and control
  characters are refused (exit 2, nothing sent), so the key cannot go to another host. There is no
  `--hostname`, `--cache`, `--preview`, `--template` or GraphQL.
- Anything but `GET` or `HEAD` needs `--confirm`, as the other changing commands do, including the
  implicit `POST` when fields are given.
- `-H` refuses credential, framing, method-override and forwarding headers: `authorization`, `proxy-authorization`, `cookie`, `host`, `content-length`, `origin`, `transfer-encoding`, `connection`, `upgrade`, `idempotency-key`, `x-http-method-override`, `x-method-override`, `x-http-method`, `x-forwarded-host`, `x-forwarded-for`, `x-forwarded-proto`, `forwarded`, `proxy-connection`, `te`, `trailer`, `keep-alive`, `expect`
  (use `--idempotency-key`). The list is the SDK's `FORBIDDEN_RAW_HEADERS`.
- Escape sequences are always stripped (`gh` has `--allow-escape-sequences`).
- `--paginate` always merges the pages of a list into one array (or one array of pages with
  `--slurp`) and needs an endpoint that returns a list; `gh` prints each page separately.
- Errors follow this CLI: exit codes 2/3/4/5, `--json` error shape, and the controller's error
  body is not printed (only its code and title). `-i` and `--verbose` therefore show response
  headers of successful answers only.

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

`src/program.ts` and `src/api-command.ts` hold the commands behind an `Io` interface (`src/io.ts`), so tests drive `run(argv, io)` with a
fake terminal, a temporary config directory and a fake controller. `src/index.ts` is the Bun entry point.

Build and check commands are in [CONTRIBUTING.md](../../CONTRIBUTING.md).
