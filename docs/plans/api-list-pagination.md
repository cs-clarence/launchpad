# Opt-in pagination for `/api/v1` list endpoints

## Assessment

- **Kind:** medium. One new convention across the controller routes, `packages/services`,
  the OpenAPI document, `packages/sdk` and docs. No schema change, no new endpoint, no
  new credential.
- **Risk tier:** High. It adds a public API contract that scripts and the planned
  `launchpad api --paginate` will depend on, and a cursor is client-supplied input that
  must never widen what an organization-scoped or project-limited key can see.
- **The four questions**
    - _What changes:_ nine list routes gain optional `limit`/`cursor` and a `Link`
      response header; the events route also gets `Link`.
    - _Who and what it touches:_ the dashboard (`apps/controller/src/server/data.ts` calls
      the list services directly), the SDK, `client-core`, the CLI and MCP (all call the SDK
      and read bare arrays), the OpenAPI document, and future `launchpad api --paginate`.
    - _What breaks if wrong:_ a client silently receives a truncated list, or a cursor lets
      a caller read another organization's or an unauthorised project's rows.
    - _How we know it works and how we undo it:_ the worked example as tests; the
      "no `limit` means identical output" tests; every step is additive and reverts alone.
- **Unknowns:**
    1. Timestamp precision. Postgres `timestamptz` has microseconds; the services return a
       JS `Date` (milliseconds). A cursor built from the `Date` would skip or repeat rows
       that tie within a millisecond. Step 1 settles this first.
    2. Whether Elysia's `set.headers` survives the `execute` return path for both success
       and error responses. Step 1 tests it.
- **Next step:** step 1.
- **Move up a kind if:** a list must change its default order, a response body must stop
  being a bare array, pagination becomes mandatory (a `limit` default), or the cursor has
  to be signed (see Approach).

## Goal and done

A caller who sends `limit` to a list endpoint gets at most that many items, in a stable
order, and a `Link: <…>; rel="next"` header when more exist; following it returns the next
page with no skipped or repeated rows. A caller who does not send `limit` gets exactly
today's response. Done when the worked example passes as tests, the OpenAPI document
describes the parameters and header, the SDK returns next-page information, and
`omni -i run check test build` is green.

Out of scope:

- Any default page size, or truncating an unpaginated call.
- Changing bodies from bare arrays, or the dashboard (it calls services in-process and
  keeps calling them without a page).
- Total counts, `rel="prev"`/`first`/`last`, sorting or filter parameters.
- CLI/MCP changes, including `--paginate`/`--slurp` (specified in
  `docs/plans/cli-api-command.md`; they come after this and only follow `rel="next"`).
- Offset pagination and cursor signing.

## Endpoint findings (checked in code)

Order and tiebreak are from `packages/services/src`; routes from
`apps/controller/src/server/api.ts`; the "project-limited" column is whether
`key.projectIds` filters the list. "Bound" is the size limit the code enforces.

| Endpoint (`/api/v1/…`)                    | Service                | ORDER BY today        | Unique tiebreak?                      | Bound                                        | Project-limited key                                                |
| ----------------------------------------- | ---------------------- | --------------------- | ------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| `organizations`                           | `listMyOrganizations`  | `organization.name`   | **No** (name not unique)              | memberships of the user                      | Route filters to the key's own org after the query (`api.ts` ~445) |
| `organizations/:o/members`                | `listMembers`          | `user.email`          | Yes (`user.email` unique)             | none stated                                  | No                                                                 |
| `organizations/:o/invitations`            | `listInvitations`      | `created_at`          | **No**                                | pending only; none stated                    | Session only (no key)                                              |
| `organizations/:o/api-keys`               | `listApiKeys`          | `created_at desc`     | **No**                                | 100 _active_; revoked/expired rows unbounded | Session only                                                       |
| `organizations/:o/projects`               | `listProjects`         | `created_at`          | **No**                                | none stated                                  | Yes, `id in (…)`; empty list short-circuits                        |
| `organizations/:o/apps`                   | `listApps`             | `created_at, id`      | Yes                                   | `LAUNCHPAD_MAX_APPS` (up to 100 000)         | Yes                                                                |
| `organizations/:o/apps/:a/aliases`        | `listAliases`          | `created_at, id`      | Yes                                   | `LAUNCHPAD_MAX_ALIASES_PER_APP` (≤ 1000)     | Yes (404 when the app's project is hidden)                         |
| `organizations/:o/apps/:a/deployments`    | `listDeployments`      | `created_at desc, id` | Yes                                   | `LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP` (≤ 1000) | Yes (404)                                                          |
| `organizations/:o/aliases/:al/operations` | `listAliasOperations`  | `generation desc`     | Yes (`UNIQUE (alias_id, generation)`) | unbounded history                            | Yes (404)                                                          |
| `organizations/:o/deployments/:d/events`  | `listDeploymentEvents` | `seq`                 | Yes (`seq`)                           | already `after`+`limit` (1–500, default 100) | Yes (404)                                                          |

Callers: dashboard `data.ts` (organizations, projects, members, api-keys, invitations;
in-process); SDK `client.ts` (`organizations`, `projects`, `apps`, `deployments`,
`aliases`, `events` etc.); `client-core/operations.ts` (organizations, projects); CLI
`program.ts` and `app-commands.ts`, MCP `server.ts` (`list_*`) all via the SDK. Every one
of them expects a bare array and none sends `limit` except `events`.

Other facts:

- Seven of ten lists need a tiebreaker added or confirmed; adding `id` (or `userId`) as
  the last `ORDER BY` only changes order among rows that tie today, which was undefined.
- `respond(request, set, access, run, successStatus)` types `set` as
  `{ status?: number | string }`. Elysia's real `set` also has `headers`; the type must
  be widened. `execute` only touches `set.status`, so headers set by `run` survive.
- The controller has no CORS plugin (only a same-origin `origin` check on cookie
  writes), so the browser sees all response headers on same-origin calls and no
  `Access-Control-Expose-Headers` is needed now. If CORS is ever added it must expose
  `Link`. This goes in the OpenAPI/README note.
- OpenAPI: `operation()` accepts `query: {name, description}[]` and renders every
  query parameter as `type: string`, and has no response-header support. It needs a
  `paginated` flag that adds integer `limit` (min 1, max 100), string `cursor`, and a
  `Link` header on the 200 response, plus a 422 error.
- Decisions: nothing in `docs/decisions/` mentions pagination, cursors or list shape, so
  nothing contradicts this. The only prior statement is in
  `docs/plans/cli-api-command.md` ("no list endpoint takes page parameters … Revisit if a
  list endpoint gains paging"), which this plan is that revisit; step 7 updates it.

Where the code disagrees with the agreed design:

1. "Keyset on a deterministic key + unique id" is not available as-is for organizations,
   invitations, api-keys and projects (no tiebreaker). The plan adds one (above).
2. Milliseconds: the cursor cannot be built from the JS `Date` the service returns (see
   Unknowns). The cursor's sort value is taken from SQL as a microsecond-precision
   string and compared in SQL.
3. The events route cannot emit `Link` from today's query because it fetches exactly
   `limit` rows and cannot tell whether more follow; it must fetch `limit + 1`.
4. `GET /organizations` filters key access in the route after the query, so a page of
   `limit` could shrink to fewer rows for a key (or be empty with a next link). The
   service must filter in SQL for keys (pass the key's organization) so pages are full.

## Design

**Request.** `limit`: optional integer, 1 to 100. `cursor`: optional opaque string,
allowed only with `limit`. No `limit` → no pagination, no `Link`, full array as today.
`limit` or `cursor` malformed, `limit` out of range, repeated, or `cursor` without
`limit` → 422 `invalid`. Unknown query parameters are ignored as today.

Why 1 to 100: matches GitHub's maximum, keeps a page small for the 100 000-row apps
quota, and is below the events maximum (500), which stays as is because it already ships.
The minimum 1 is useful for tests and probing. There is deliberately no default: the
default is "all".

**Response.** Status 200, body a bare array of at most `limit` items, in the same order
as the unpaginated call. When more rows exist, a `Link` header
`</api/v1/organizations/ORG/apps?limit=50&cursor=OPAQUE>; rel="next"`:

- A _relative_ reference (RFC 8288 permits it), built only from the route's own path, the
  `limit` and the new cursor, so it cannot be steered to another host and does not depend
  on proxy `Host` handling. Clients resolve it against the request URL.
- Percent-encoded path segments as in the request; no other incoming query is copied.
- Absent on the last page. The service fetches `limit + 1` rows, returns `limit`, and the
  extra row only proves a next page exists, so an exact-multiple last page has no `Link`.

**Cursor.** URL-safe base64 of JSON
`{"v":1,"r":"<route key>","o":"<org id>","k":[sort values…],"id":"<tiebreak>"}`:

- `r` is a fixed string per list (`apps`, `deployments:<appId>`, `alias-ops:<aliasId>`, …)
  so a cursor from one route or parent is refused on another. `o` is the organization ID
  from the path (for `organizations` it is the empty string and the user is implied).
- `k` is the last row's sort values: for time keys, the database's text rendering with
  microseconds (`to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`), not a JS `Date`.
- The query uses a row comparison, e.g. `(created_at, id) > ($k, $id)` (or `<` for
  `desc`), with the same `ORDER BY`; this is keyset, so concurrent inserts and deletes do
  not shift later pages.
- Decoding is strict: size cap (512 bytes), exact keys, `v === 1`, UUID/date/number shape
  checked per list. Anything else, or `r`/`o` not matching the current request, is
  422 `invalid` ("The cursor is not valid for this request."), never 404 and never a
  different list.

**Signature or not: no signature.** Reasoning:

- The cursor holds only a boundary position taken from a row the caller was already
  allowed to see. A forged cursor can only choose a different starting point _inside the
  query the server still builds itself_: `organization_id`, the parent ID from the path
  and the key's project allow-list are always applied in SQL from the authenticated
  request, never from the cursor. So a forged cursor cannot reveal a row the caller could
  not list unpaginated.
- Route and organization binding therefore prevents mix-ups (and gives a clear 422), not
  an escalation. Per-key binding is not needed: a restricted key's cursor reused by an
  unrestricted key just starts at that boundary of a list that key may read anyway.
- A signature would need a controller secret and key rotation handling, which breaks
  cursors across rotation, for no authorization benefit. Revisit if a cursor ever
  carries data other than sort values (move up a kind).

**Events.** Keeps `after` (decimal `seq`) and `limit` (1–500, default 100) and the bare
array. It now also emits `Link: <…/events?after=<last seq>&limit=<limit>>; rel="next"`
when a `limit + 1` read shows more events exist, so generic link-following works. `after`
stays the documented contract; a `cursor` parameter is not added to this route.

**Project-limited keys.** The key's `projectIds` filter is applied in SQL as today, before
the page cut. Consequences covered by tests: every page is full except the last; a hidden
project's rows never contribute to a boundary; an empty allow-list returns `[]` with no
`Link`; hidden parents still 404 on every page, including with a cursor.

**SDK.** `request()` also exposes the response. A new internal `requestPage` returns
`{ items, next?: { cursor: string } }` where `next` comes from parsing `Link` and is set
only when the link is relative or same-origin, starts with the `/api/v1` prefix and has a
`cursor` parameter (anything else is ignored, not followed). Existing `list(...)` methods
keep their signature and return type. New: `listPage(o, { limit, cursor? })` on the
paginated resources, and `events` gains a typed `nextAfter` via `eventsPage`. The `raw`
method planned in `cli-api-command.md` must return response headers; this plan states
that requirement and leaves `raw` to that plan.

## Worked example

Fixture: an organization with 5 apps whose first three have the _same_ `created_at` to
the microsecond (tie), plus a second organization with its own apps.

Happy path:

- `GET …/apps` (no `limit`) → 200, five items, no `Link`, byte-identical to today's body.
- `GET …/apps?limit=2` → two items, `Link` rel="next" with `limit=2&cursor=…`.
- Following the link twice yields items 3–4 then item 5 (last page, no `Link`). The
  concatenation equals the unpaginated array, with no repeats, including across the
  three-way timestamp tie.
- SDK `apps.listPage(org, { limit: 2 })` returns `{ items, next }`; passing `next.cursor`
  returns the next page.

Complexities:

- Concurrent insert: after page 1, a new app is created; pages 2 onward contain it if it
  sorts after the cursor and never repeat or skip an old row. A row deleted between pages
  is simply absent.
- `desc` lists (`deployments`, `api-keys`, `alias operations`) page in descending order
  with `<` comparison; a row inserted at the head after page 1 does not appear on later
  pages.
- Project-limited key (projects P1, P2 of 5): `?limit=1` pages only through apps in P1
  and P2; a cursor made by an unrestricted session and used by the key still returns only
  P1/P2 rows.
- Events: `?limit=2` over 5 events emits `Link` with `after=<seq 2>&limit=2`; the last
  page (1 event) has none; `after` without `limit` behaves exactly as today.
- Header on error: any 4xx has no `Link`.

Edge cases:

- Empty list with `limit=10` → `200 []`, no `Link`.
- Exact multiple: 4 items, `limit=2`: page 2 returns two items and no `Link`.
- `limit=5` on 5 items: one page, no `Link`.
- `limit=0`, `101`, `-1`, `abc`, `2.5`, `1e2`, `limit=1&limit=2`: 422.
- `cursor` without `limit`: 422.
- Tampered cursor (flipped bytes, not base64, wrong JSON, extra keys, oversize, wrong
  `v`, non-UUID `id`, SQL text in a value): 422, no query run on its content.
- Foreign cursor: apps cursor on `/projects`, org A's cursor on org B, app A's cursor on
  app B's deployments: 422.
- Cursor whose boundary row has since been deleted: still valid (keyset), returns the
  following rows.
- Key outside the organization: 403 as today, before cursor handling.
- `Link` never contains `Authorization` data, another host, or an incoming query other
  than `limit` and `cursor`.
- Regression: `list` in SDK, CLI, MCP, dashboard unchanged without `limit`.

## Approach

Add one small pagination module in `packages/services` (`pagination.ts`): parse/validate
`limit` and `cursor`, encode/decode the cursor, and apply the row-comparison and
`limit + 1` to a Kysely query given the list's key spec. Each list service takes an
optional `page` argument; without it, it runs the same query as today (plus the added
tiebreaker). The route calls a helper that parses the query, calls the service, and
sets `Link` through `set.headers` only when a next page exists.

Rejected:

- **Always paginate with a default `limit`.** Breaks the dashboard, SDK, CLI and MCP
  (silent truncation); this is the stated reason for opt-in.
- **Offset pagination.** Skips/repeats rows on concurrent writes and gets slow with deep
  offsets on the 100 000-app quota.
- **Wrapper body `{items, next}`.** Breaking change for every client; the header keeps
  bodies as they are.
- **Signed cursor (HMAC).** No authorization benefit (see Design), adds a secret and a
  rotation failure mode.
- **Absolute `Link` URLs from the configured `origin`.** Wrong behind a proxy/alias host
  and easier to get wrong; relative links are standard and the client verifies them.
- **Cursor built from the JS `Date`.** Millisecond loss breaks ties.
- **A cursor parameter on events.** Would change a shipped contract; `after` is enough.

## Steps

Each step is safe to stop after: nothing paginates until a route opts in.

1. **Thin slice: `apps` list end to end, with the pagination module.** Riskiest, first
   (microsecond keyset, `set.headers`, tiebreak, 422). Add `pagination.ts`; `listApps`
   `page` argument; route parsing and `Link`; widen the `set` type; OpenAPI `paginated`
   flag for that route. _Check:_ the apps worked-example tests (tie to the microsecond,
   concurrent insert, project-limited key, exact multiple, empty, tampered/foreign
   cursor), and a test that an unpaginated call equals the pre-change body. _Undo:_
   revert; additive and unused by any client.
2. **Remaining `(created_at, id)` lists:** `projects`, `aliases`, `invitations`
   (adding `id` tiebreak to `projects`, `invitations`). _Check:_ the same table tests
   per endpoint, incl. hidden-parent 404 on a paged call. _Undo:_ revert per endpoint.
3. **`desc` and non-time lists:** `deployments`, `api-keys` (add `id`), `alias
   operations` (by `generation`), `members` (by email, `userId`), `organizations`
   (add `organization.id`; move the key's organization filter into SQL). _Check:_ `desc`
   page-order tests and full pages for a key restricted to one organization. _Undo:_
   revert per endpoint.
4. **Events `Link`:** `limit + 1` read, `Link` with `after`/`limit`. _Check:_ events
   example above; default behavior with no `limit` unchanged. _Undo:_ revert.
5. **OpenAPI and docs:** all routes use `paginated`; document the `Link` header,
   cursor opacity ("do not parse or build cursors"), `limit` bounds, 422, and the CORS
   note, in `apps/controller/README.md` and the served document. _Check:_ an OpenAPI
   test that each paginated route lists `limit`, `cursor` and `Link`; `omni -i run
   check`. _Undo:_ revert.
6. **SDK:** `requestPage`, `listPage`, `eventsPage`, same-origin `/api/v1` link
   validation, plus the `raw` header requirement noted for the CLI plan. _Check:_ SDK
   tests with a fake `fetch`: next link followed, absolute foreign-host link ignored,
   missing prefix ignored, existing `list` unchanged. _Undo:_ revert (additive).
7. **Update `docs/plans/cli-api-command.md`** (endpoint findings, `--paginate`/`--slurp`
   now possible and restricted to same origin plus `/api/v1` prefix; they stay a later
   step of that plan). _Check:_ read-through; `omni -i run check`. _Undo:_ revert.

## Risks

- **Riskiest (step 1):** keyset comparison silently skipping or repeating tied rows.
  Mitigation: microsecond text cursor, SQL row comparison, a fixture with identical
  timestamps run against the real database test harness.
- A cursor from one scope used on another leaks nothing but gives wrong data: bound by
  `r`/`o` and tested.
- Pages emptied by post-query filtering (the `organizations` key filter): moved into SQL,
  tested.
- Header lost on some path: tested for success and the 422 path.
- Clients following `Link` to another host with a key: the controller only emits
  relative links, and the SDK/CLI check origin and prefix.
- Adding an `id` tiebreak slightly changes order among previously tied rows (undefined
  before): noted in release notes.
- Unbounded lists (`alias operations`, revoked `api-keys`) stay unbounded unpaginated;
  accepted, callers can now opt in.

## Verification and undo

`omni -i run check test build`; the service tests use the real database harness already
used by the services. No data, migrations, or deployment effects, and no new
dependencies. Undo is reverting the steps in reverse order; nothing persists.

## Open questions

- None blocking. Non-blocking: whether the default maximum should later be raised from
  100 for the 100 000-app quota (owner: maintainers; changing it is additive).

## Status

Built, steps 1 to 7, in PR #88. Verified: `omni -i run check test build` and
`omni -i run test:integration` (the database-backed pagination specs) are green against a
disposable PostgreSQL, and two independent reviews passed. CodeRabbit's three findings (members
compared by `userId` in the traversal test, SDK cursor bound 1024, cursor validated on an empty
allow-list) are fixed.

Findings and deviations:

- `@elysia/openapi` replaces a route's `detail.parameters` with the ones derived from the
  route's own schemas, so query parameters (and `Idempotency-Key` headers, a pre-existing
  gap) declared in `detail` never reach the served document. Paginated routes and the events
  route therefore also pass a permissive zod `query` schema (`pageQuery`, `eventsQuery`) whose
  only job is documentation; the services still validate and return the API's 422. The
  `Idempotency-Key` documentation gap is left as is.
- The plan's session-only lists (invitations, API keys, and a user's multiple organizations)
  cannot be reached over HTTP in the key-based test harness; they are tested at service level.
- Events emit `Link` only when `limit` is given (so `after` alone is unchanged).
- A `limit`-less call is served by the pre-existing service function (now ordered through the
  same key spec); each paged list has a separate `list*Page` service function.
- Not done: a decision record in `docs/decisions/` (optional in this plan).
- Left to `cli-api-command.md`: `raw` returning response headers, and `--paginate`.
