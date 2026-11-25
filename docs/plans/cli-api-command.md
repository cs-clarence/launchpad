# CLI `api` command (raw controller API access)

Modeled on `gh api` (GitHub CLI 2.x `gh api --help`); differences are listed under
"Deliberate differences from `gh api`".

## Assessment

- **Kind:** medium work for part 1 (key-only `launchpad api`). Part 2 (operator/owner
  session login) is large and is **not planned here**; it needs a decision record first.
- **Risk tier:** High. It sends a credential to a caller-chosen path, adds a public CLI
  contract, and part 2 would add a new credential type.
- **How much changes:** `packages/sdk` (one generic method), `apps/cli` (one command),
  docs. No controller, database or contract changes.
- **Unknowns:** none that block step 1. Pagination and jq are settled below.
- **Next step:** step 1 below.
- **Move up a kind if:** part 2 starts, the controller needs a new endpoint or scope, or the
  raw call has to bypass the SDK's transport limits.

## Goal and done

`launchpad api <endpoint> [flags]` calls any `/api/v1` endpoint with the saved profile or
`LAUNCHPAD_CONTROLLER` / `LAUNCHPAD_API_KEY` and prints the response. Done when the worked
example passes as tests and `omni -i run check test build` is green.

Out of scope: session or password login, operator endpoints, org/member/key creation (they
need a session and stay dashboard/HTTP only), `--cache`, `--preview`, `--hostname` (the
profile already names the controller), GraphQL, controller changes.

## Flags (copied from `gh api` unless noted)

| Flag                    | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<endpoint>`            | Path under `/api/v1`, with or without a leading `/`.                                                                                                                                                                                                                                                                                                                                                                                             |
| `-X, --method`          | Default `GET`; `POST` if any field was added (as `gh`). With `--method GET`, fields become the query string.                                                                                                                                                                                                                                                                                                                                     |
| `-f, --raw-field k=v`   | String parameter.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `-F, --field k=v`       | Typed: `true`, `false`, `null` and integers become JSON types; `@path` reads the value from a file, `@-` from stdin.                                                                                                                                                                                                                                                                                                                             |
| nested keys             | `a[b]=c` nests; repeated `a[]=x` builds an array; bare `a[]` is an empty array.                                                                                                                                                                                                                                                                                                                                                                  |
| `--input file\|-`       | Raw body (1 MiB cap). Fields then go to the query string, as in `gh`.                                                                                                                                                                                                                                                                                                                                                                            |
| `-H, --header k:v`      | Extra headers, except these, which are refused (the SDK's `FORBIDDEN_RAW_HEADERS`): `authorization`, `proxy-authorization`, `cookie`, `host`, `content-length`, `origin`, `transfer-encoding`, `connection`, `upgrade`, `idempotency-key`, `x-http-method-override`, `x-method-override`, `x-http-method`, `x-forwarded-host`, `x-forwarded-for`, `x-forwarded-proto`, `forwarded`, `proxy-connection`, `te`, `trailer`, `keep-alive`, `expect`. |
| `-i, --include`         | Print the status line and response headers first.                                                                                                                                                                                                                                                                                                                                                                                                |
| `--silent`              | No body output.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--verbose`             | Print the request and response, with the key and `set-cookie` redacted.                                                                                                                                                                                                                                                                                                                                                                          |
| `-q, --jq <expr>`       | Filter the JSON response. Uses the system `jq` when found on `PATH`, otherwise `@elastic/micro-jq`.                                                                                                                                                                                                                                                                                                                                              |
| `--paginate`, `--slurp` | `GET` only. Follows `rel="next"` of a list only if same-origin and the exact `/api/v1` path requested (the SDK's `nextLink`, via `raw().next`); merges the arrays, or `--slurp` wraps the pages. Events keep `after`/`limit`.                                                                                                                                                                                                                    |
| placeholders            | `{org}` and `{project}`; see Placeholders. A placeholder with no value is a usage error.                                                                                                                                                                                                                                                                                                                                                         |
| `--idempotency-key`     | Launchpad-specific; passed through with the SDK's format check.                                                                                                                                                                                                                                                                                                                                                                                  |

## Endpoint findings

Checked `apps/controller/src/server/openapi.ts` (the `/api/v1` operations) and the SDK.

- **Every list endpoint now takes opt-in paging** (see
  [api-list-pagination](api-list-pagination.md)): `limit` (1 to 100, no default) and an
  opaque `cursor`, with a relative `Link: <...>; rel="next"` header while more items exist.
  Without `limit` a list returns the whole bare array as before. Deployment events keep
  `after` and `limit` (1 to 500, default 100) and also send `Link` with
  `after=<last seq>&limit=<n>` when `limit` is given and more events exist.
- So `gh`'s `--paginate`/`--slurp` can be copied later: `--paginate` follows `rel="next"`
  and concatenates the arrays; `--slurp` wraps the pages in one array. They must follow a
  link only if, once resolved against the request URL, it is on the profile's origin, lies
  under `/api/v1` and names the same path, and must never send the key anywhere else.
  `raw` returns response headers and a validated `next` query (the SDK's `nextLink`), so
  `--paginate`/`--slurp` are part of step 3.
- The controller serves its own OpenAPI document at `/api/openapi/json` (reference at
  `/api/openapi`), outside `/api/v1`, so `launchpad api` cannot fetch it; it is the reference
  for `launchpad api` users.
- The write endpoints that need a session (organization, member, invitation and key
  creation or revocation) are listed too; an API key gets 401/403 from them, so `api`
  reaches them only after part 2.

## jq

`--jq` runs the expression on the response body, as `gh` does:

1. If `jq` is on `PATH`, spawn it (no shell, expression passed as an argument, response on
   stdin, timeout, output cap).
2. Otherwise use `@elastic/micro-jq` (v2.0.2, Apache-2.0, on npm, provenance-attested; a
   JS jq subset, so very advanced filters may differ). Say which engine ran under
   `--verbose`.
   Adding it needs the dependency to be pinned and checked per the repo's dependency rules
   (`docs/guidelines/authoring`), in its own step so it can be reverted alone.

## Placeholders

Copied from `gh`'s `{owner}`/`{repo}`/`{branch}`, but only values the CLI already knows:

| Placeholder | Source, in order                                                                                            | Notes                         |
| ----------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `{org}`     | The selected organization (`launchpad org use`), else `launchpad.json` `organization`, else `LAUNCHPAD_ORG` | An ID, as the API paths need. |
| `{project}` | Nearest `launchpad.json` `project`                                                                          | Only from the workspace file. |

Not added: `{profile}` (not part of an API path), `{app}`, `{alias}`, `{deployment}` (no
current-resource concept; pass the ID). Values are percent-encoded as one path segment and
`.`/`..` are refused. Placeholders apply to the endpoint and to `-F`/`-f` values, as in `gh`.
`launchpad.json` keeps its existing rule: it is read-only context, never a mutation target
by itself, so a non-GET using `{project}` still needs `--confirm`.

## Deliberate differences from `gh api`

- **Full URLs, schemes, `//host`, `..`, fragments and control characters in the endpoint are
  refused** (exit 2, nothing sent), so the key cannot go to another host.
- **Non-GET requires `--confirm`**, matching this CLI's existing destructive commands.
  `gh` has no such flag; the implicit `POST` when fields are given still applies, but needs
  `--confirm`.
- **Terminal escape sequences in output are stripped by default** (`gh` has
  `--allow-escape-sequences` to allow them); the response is untrusted data.
- Output follows this CLI's conventions: `--json` global flag, exit codes 2/3/4/5, and error
  shape `{"error":{"code","message"}}` on stderr. HTTP errors do not print the raw body.

## Worked example

Happy path:

- `launchpad api key` prints the key's JSON.
- `launchpad api organizations/{org}/projects -f name=Demo -f slug=demo --confirm` creates a
  project (key needs `project:create`) and prints it.
- `launchpad api -X POST organizations/{org}/projects --input body.json --confirm`.
- `launchpad api "organizations/{org}/deployments/${DEPLOYMENT_ID}/events" -F after=12 -F limit=500 --method GET`
  sends `?after=12&limit=500`.
- `launchpad api organizations/{org}/apps --jq '.[].slug'` prints one slug per line.

Complexities:

- Typed and nested fields: `-F n=3 -f s=3 -f k[]=a -f k[]=b` gives
  `{"n":3,"s":"3","k":["a","b"]}`.
- Non-JSON, empty (204) and oversized (>1 MiB) responses; `-i` header output.
- `{org}` with no selection; with a key restricted to another organization (controller 403
  maps to exit 3).

Edge cases (refused before any request, exit 2):

- `https://evil.example/x`, `//evil/x`, `a/../b`, `x#y`, newline in the endpoint.
- `-H authorization:...`, `-H cookie:...`, `--confirm` missing on non-GET, bad JSON or
  over-size `--input`, `-F k=@missing`.
- The key never appears in any output, including `--verbose` and error messages.

## Approach

Add `client.raw(method, path, { query, body, headers, idempotencyKey, signal })` to
`packages/sdk` that reuses the existing `request()` (Bearer header, timeout, bounded read,
redirect refusal, error mapping) and validates the path once, so every caller gets the same
guard. The CLI parses flags, builds the body (field parser in `packages/client-core` so MCP
could reuse it later), and prints.

Rejected: a separate `fetch` in the CLI (duplicates the transport and key-leak guards);
accepting full URLs like `gh` does for Enterprise (the key could be sent elsewhere).

## Steps

1. **SDK `raw` with path and header validation, plus tests.** Riskiest, first. Verify:
   hostile-path table test (nothing sent), happy, error and empty-body cases. Undo: revert
   (additive, unused).
2. **Field parser (`-f`, `-F`, nesting, `@file`) in `client-core`, pure and unit-tested.**
   Independent of 1. Verify: table tests from the worked example. Undo: revert.
3. **CLI `api` command wiring flags, placeholders, `-i`, `--silent`, `--verbose`, escape
   stripping.** Depends on 1 and 2. Verify: the worked example as `program.spec.ts` tests,
   including key redaction, `--paginate` and `--slurp`. Undo: revert.
4. **Docs** in `apps/cli/README.md` (command line, differences from `gh`) and a note in
   `apps/controller/README.md` that the CLI reaches key-allowed endpoints only. Verify:
   `omni -i run check`. Undo: revert.
5. **`--jq` with system-`jq` preference and an `@elastic/micro-jq` fallback.** Depends on 3. Verify: tests with and without `jq` on `PATH` (inject the finder), timeout and output
   cap, and an invalid expression exiting 2. Undo: revert, which removes the dependency.

Every step is safe to stop after.

## Risks

- **Riskiest (step 1):** path validation misses a form that sends the key elsewhere.
  Mitigate by building the URL with `new URL(path, base)` and asserting origin and the
  `/api/v1` prefix are unchanged, plus a hostile-path table test.
- Key echoed by `--verbose` or errors: reuse the SDK redaction and test it.
- Scripts treat the raw surface as a contract. Document it as following the controller's
  OpenAPI, which may change.

## Verification and undo

`omni -i run check test build`. Part 1 is additive; removing the command and the SDK method
undoes it. No data or deployment effects.

## Part 2 (not planned): session login for admin use

Needed for org, member and key creation. Requires a decision record in `docs/decisions/`
first:

- Where a session lives, its lifetime, and the 15-minute freshness rule for key issue.
- Whether the credential file may hold a password-derived session, kept apart from the
  CI-readable key profile.
- Whether the operator surface belongs in the consumer CLI or in `admin`.
- How trusted proxy and origin/CSRF checks apply to a non-browser client.

## Open questions

- None. The micro-jq dependency fits the repo's dependency rules (checked in step 5).

## Status

Built on branch `feat/cli-api-command` (not committed). All five steps are done; checks
below are green per step and for the whole tree.

1. SDK `raw` (`packages/sdk/src/client.ts`): done. Path and header validation, hostile-path
   and header table tests, nothing sent on refusal. `send` was split so `raw` and the typed
   calls share one `exchange` (key header, timeout, bounded read, redirect refusal, error
   mapping). Extra over the plan: `raw` returns `next`, the query of a validated `rel="next"`
   (reusing `nextLink`), for `--paginate`. Refused beyond the plan: `%2f`, `%5c`, `%00`,
   encoded dot segments, `proxy-authorization`, `transfer-encoding`, `connection`,
   `upgrade` and `idempotency-key` as a header.
2. Field parser (`packages/client-core/src/fields.ts`): done, with `fieldsToQuery` for
   `GET`/`--input`. Limits: 200 fields, depth 8; `[]` only at the end of a name; `__proto__`,
   `constructor`, `prototype` refused; an integer outside the safe range stays a string.
3. CLI command (`apps/cli/src/api-command.ts`): done, including `--paginate`/`--slurp`
   (in scope now that pagination has merged). Deviations: `{org}` falls back to the key's own
   organization (as every other command does) rather than being an error when none is
   selected; it resolves only when a placeholder uses it, so a plain call makes no extra
   request. `--paginate` cannot be combined with `-i`; it stops after 1000 pages or 100000
   items, or if a link repeats. `Io` gained `readData` (1 MiB, refuses the credential store)
   and an optional `findExecutable`. Error responses print only code and title, so `-i` and
   `--verbose` show response headers of successful answers only.
4. Docs: done (`apps/cli/README.md`, `apps/controller/README.md`). The OpenAPI document is at
   `/api/openapi/json`, not `/api/v1/openapi` as first written; corrected above.
5. `--jq` (`apps/cli/src/jq.ts`): done. The dependency rules (`docs/guidelines/authoring/dependencies.md`,
   `docs/tooling.md`: versions from the root catalog, `check:deps`) allow it. `@elastic/micro-jq`
   2.0.2: Apache-2.0, no dependencies, npm provenance attestation, ~450 KB unpacked. Added with
   `bun add --exact --catalog` in `apps/cli` (the tool wrote the lockfile; the catalog entry was
   re-placed by hand in `package.json` to avoid Bun re-sorting the whole catalog, and `bun install`
   confirmed the lockfile unchanged). It is used only in `apps/cli/src/jq.ts`. Engine differences:
   the built-in engine returns one value, so a stream is detected by a heuristic (expression
   iterates `[]` and does not start with `[`); it supports a subset (no `map`). The expression is
   checked before the request (system jq: `jq -n`, exit 3 is a compile error). The packaged-CLI
   check (`test:packages`, needs the network) was not run.

### Review follow-up

Independent review (PASS) findings, all addressed: placeholder values are substituted after
`@`/typing is decided (so a value cannot read a file or become a number) and into split query
pairs (so `&`/`=` cannot add parameters); `-X` is validated before any I/O; `readData` stats
before opening and opens non-blocking (a hard link into the credential store is not detected,
documented); jq's program is passed without `--` (a leading `-` gets a space, for jq 1.6), and
the built-in stream heuristic now needs an iterator after a path (`.x // []` is a value);
`--paginate` seeds the loop guard with the first query and stops at 16 MiB; the refused-header
list and allowed methods are shared SDK constants (`FORBIDDEN_RAW_HEADERS`, `RAW_METHODS`).

Second review follow-up: the refused-header list gained method-override and forwarding headers;
`--paginate` counts bytes, has a 5 minute overall deadline (exit 5), and `--verbose` prints the
request before sending; a `--jq` failure after the request exits 1 with a message saying the
request succeeded; `@file` values are not scanned for placeholders; `/proc` and `/sys` files
are refused on Linux.

### Code review follow-up (PR #91)

Fixed: README shell examples no longer use `<...>` (a test checks the `sh` blocks); the test harness
records every fetch (`requests`) so refusal tests prove "no request" including the organization
lookup; numbers are preserved by a token-preserving printer and textual page merge
(`apps/cli/src/json-text.ts`) and `--input` is sent as bytes (`raw` accepts `Uint8Array`);
`--jq ""` and an invalid `--jq` are refused before any lookup or request; one `launchpad.json`
read and one profile resolution serve `{org}`, `{project}` and the request (the `{org}` check is
done inline instead of through `workspaceContext`, with the same visibility rule); `--verbose`
hides the values of refused headers; `findOnPath` tries `jq.exe` on Windows; a stopped jq's pipes
are destroyed; `nextLink` accepts the path under a prefixed `baseUrl` (and the controller's own
`/api/v1` form, since only the link's query is used).

Documented limit: the built-in micro-jq engine, and system jq older than 1.7, read numbers as
doubles, so a filter rounds integers above 2^53; without `--jq`, and with system jq 1.7+, they are
exact. The single-snapshot race for `launchpad.json` cannot be forced in a unit test; the test
checks both placeholders come from one read and one lookup, and the profile race is tested.
