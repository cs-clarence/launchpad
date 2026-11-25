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

| Flag                    | Behavior                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `<endpoint>`            | Path under `/api/v1`, with or without a leading `/`.                                                                               |
| `-X, --method`          | Default `GET`; `POST` if any field was added (as `gh`). With `--method GET`, fields become the query string.                       |
| `-f, --raw-field k=v`   | String parameter.                                                                                                                  |
| `-F, --field k=v`       | Typed: `true`, `false`, `null` and integers become JSON types; `@path` reads the value from a file, `@-` from stdin.               |
| nested keys             | `a[b]=c` nests; repeated `a[]=x` builds an array; bare `a[]` is an empty array.                                                    |
| `--input file\|-`       | Raw body (1 MiB cap). Fields then go to the query string, as in `gh`.                                                              |
| `-H, --header k:v`      | Extra headers, except `authorization`, `cookie`, `host`, `content-length` and `origin`, which are refused.                         |
| `-i, --include`         | Print the status line and response headers first.                                                                                  |
| `--silent`              | No body output.                                                                                                                    |
| `--verbose`             | Print the request and response, with the key and `set-cookie` redacted.                                                            |
| `-q, --jq <expr>`       | Filter the JSON response. Uses the system `jq` when found on `PATH`, otherwise `@elastic/micro-jq`.                                |
| `--paginate`, `--slurp` | Possible now (see Endpoint findings) but not in part 1; a later step. Follows only same-origin `rel="next"` links under `/api/v1`. |
| placeholders            | `{org}` and `{project}`; see Placeholders. A placeholder with no value is a usage error.                                           |
| `--idempotency-key`     | Launchpad-specific; passed through with the SDK's format check.                                                                    |

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
  `--paginate` is not part of step 1; it needs the raw method to return response headers,
  which the SDK's `raw` does not yet (stated in the pagination plan, left to this plan).
  Until then, page by hand with `-F limit=50 --method GET` and `-i`.
- The controller serves its own OpenAPI document at `/api/v1/openapi`, which is the
  reference for `launchpad api` users.
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
- `launchpad api organizations/{org}/deployments/<id>/events -F after=12 -F limit=500 --method GET`
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
   including key redaction. Undo: revert.
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

- None blocking. Confirm the micro-jq dependency fits the repo's dependency rules before
  step 5.

## Status

Planned; nothing built.
