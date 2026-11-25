# CLI access to session-only actions (part 2 of `launchpad api`)

Status: accepted by the user on 2026-11-25 (option B, with the answers under "Decision"). For contributors
building session access in the CLI. This is "part 2" of
[the `launchpad api` plan](../plans/cli-api-command.md).

## Problem

API keys deliberately cannot create organizations or manage members, invitations or keys
([organization roles and operator access](organization-roles-and-operator-access.md);
`apps/controller/src/server/openapi.ts`). Those endpoints take only the session cookie, and
issuing a key also needs a session created in the last 15 minutes. So key-only
`launchpad api` cannot reach them. Until now they were dashboard-only, or scripted over HTTP
as `tooling/local-seed.ts` and `tooling/experiments/acceptance/world.ts` do.

## What the code does today

- **Session** (`packages/auth/src/create-auth.ts`, `config.ts`): Better Auth email and
  password, minimum 12 characters (the admin commands cap it at 128,
  `MAX_PASSWORD_LENGTH` in `packages/auth/src/setup.ts`). Lifetime 7 days, refreshed after
  1 day of use. Cookie `better-auth.session_token`, `__Secure-` prefixed over HTTPS. Sign-in is
  `POST /api/auth/sign-in/email`, sign-out `POST /api/auth/sign-out` (revokes the session;
  `apps/controller/src/__tests__/hop.spec.ts`). A new sign-in creates a new session; the
  client never supplies an identifier, so there is no fixation.
- **Throttling:** the controller (`apps/controller/src/server/api.ts` `throttleSignIn`,
  `packages/auth/src/login-throttle.ts`) allows 5 per 60 s per (client IP, email) and 20 per
  10 min per email, counting every attempt. Over the limit it answers 429 with
  `retry-after: 60`. Better Auth's own limiter (5 per 60 s on `/sign-in/email`) answers 429 with
  `X-Retry-After` (`better-auth` `rate-limiter/index.mjs`). If the controller cannot determine
  the client address it answers 400 `client-address-unavailable`. A retry loop therefore
  locks the account's dashboard sign-in too.
- **Origin rule** (`api.ts` `onRequest`): a non-`GET` request to `/api/v1` with a `cookie`
  header must carry `Origin` exactly equal to the configured controller origin, else 403
  `forbidden-origin`. `/api/auth/*` is checked by Better Auth's `trustedOrigins` (the same
  origin). A non-browser client sends `Cookie` and `Origin` itself, as both scripts do.
- **One credential per request:** an `Authorization` header alone decides (`callerOf`); the
  session is read only when there is none.
- **Freshness:** `FRESH_SESSION_MS` is 15 minutes from the session's `createdAt`, for key
  issue (`POST /api/v1/organizations/:orgId/api-keys`) and requesting review of held work. Refresh
  does not extend it; only a new sign-in does.
- **Who can do what:** only the operator creates organizations
  (`POST /api/v1/organizations`, `createOrganization` in `packages/services/src/organizations.ts`),
  naming an existing, grantable user as first owner; the operator gets no membership. Owners and
  admins issue keys (`apikey:manage`), manage members and invite. A non-member gets 404.
- **Credential store:** `packages/client-core/src/store.ts`: `credentials.json`, version 1,
  profile `{ controller, apiKey, organizationId, savedAt }`, 0700 directory, 0600 file, no links,
  owned by the user, atomic replace under `credentials.json.lock`. `LAUNCHPAD_CONTROLLER` plus
  `LAUNCHPAD_API_KEY` bypass it (CI).
- **SDK and CLI:** the SDK sends only a Bearer key; `raw` refuses `authorization`, `cookie` and
  `origin` headers (`FORBIDDEN_RAW_HEADERS`, `packages/sdk/src/client.ts`).
  `normalizeBaseUrl` already requires https, allows http only for `localhost`, `127.0.0.1`
  and `[::1]`, and refuses credentials, query and fragment (path kept). `tooling/local-seed.ts`
  accepts any http/https URL, so it is not a rule to reuse. The CLI has `Io.readSecret` (hidden
  prompt, 4096-byte cap) and `Io.readFile` (follows links) in `apps/cli/src/io.ts`; output passes
  `safeOutput`, which redacts `lp_…` strings (`packages/client-core/src/redact.ts`).

## Options

Common to all: no password in arguments or the environment; the controller's checks (roles, 404,
last-owner, audit) remain the only authorization.

**A. Do nothing in the CLI.** Docs only. No new credential, but owners and the operator cannot
automate or work from a terminal. Undo: none.

**B. `--session` in the CLI.** Sign in with email and password, call session-only endpoints.
Changes only the CLI, SDK and client-core; no controller change. Detailed below. Undo: low (see
"Undo").

**C. Device code or browser handoff.** Best credential (password never reaches the CLI, token
scoped and short). Needs a controller table and migration, start/poll/approve endpoints, a
dashboard approval page requiring a fresh session, a new token type in `callerOf` with an
allow-list of endpoints, expiry, revocation and audit. Better Auth has a device plugin, but its
organization endpoints are closed by decision, so it needs its own review. Large, High risk, high
undo cost. Rejected for now (the user chose no controller change); reopen if B proves too weak.

**D. Separate operator tool (`admin` over HTTP).** The consumer CLI that CI runs would have no
session code at all. But `admin` runs on the host with database access, so this would be a second
HTTP client with the same password handling and no gain over B for owners. Rejected.

**E. A key class that may manage organization, member or key resources.** Contradicts the
accepted decision that keys cannot mint or widen credentials; a key cannot prove the 15-minute
freshness, and a leak would be self-renewing. Rejected; it would need a decision superseding the
accepted one.

## Decision

Build **B**, as follows. The user's answers are decisions, not open questions.

1. **Who:** the operator and organization owners/admins, with their own account. The operator
   still has no access inside an organization without membership.
2. **Default flow: an in-memory session.** When no kept session exists for the controller,
   `launchpad api --session --email <address>` signs in itself (hidden prompt, or
   `--password-file`; without `--email` it exits 2 with a usage message naming `--email`), makes
   its call or calls (all pages of `--paginate` share one session), then
   signs out. The session is never written to disk and is always new, so key issuance works. A
   hard kill (SIGKILL, power loss) or an unreachable controller at sign-out leaves a server
   session that expires on its own after at most 7 days; sign-out is best effort and the docs say
   so. A failed sign-out prints a warning and does not change the exit code of a call that
   succeeded.
3. **Signals:** the CLI has no signal handling today. SIGINT, SIGTERM and SIGHUP handlers are
   installed only around an active session (including the prompt) and removed in `finally`. On a signal the CLI aborts the
   request, signs out (bounded by the transport timeout) and exits; a second signal exits
   immediately. At the hidden prompt the terminal is in raw mode, so Ctrl-C arrives as `\u0003`
   data, which `readSecret` already turns into a rejection that restores the terminal; only
   SIGTERM and SIGHUP arrive as real signals there. Those must restore the terminal (raw mode
   off, newline) before exiting.
4. **`--keep`:** the only mode that writes a session. `api --session --keep` signs in, calls, and
   stores the session instead of signing out; `launchpad login --session --email <address>` is
   the same without a call and prints the controller and the account email. Both always need
   credentials (`--email` and a password), even when an entry exists: with an existing entry for
   the controller, `--keep` behaves exactly as `login --session`: it signs the old server session
   out (a failure is a warning), then replaces the entry, so no old session is orphaned. A
   different `--email` is allowed there, because it replaces rather than reuses.
   `launchpad logout --session` calls sign-out, then deletes the entry, even if sign-out failed
   (warning). With no entry it says so and exits 0; `--email` is ignored. A 401 from a kept session
   deletes the entry and says to sign in again.
5. **Using a kept session:** plain `api --session` (no `--keep`) with an entry for the controller
   uses it with no prompt; the stored account is used, so `--email` may be omitted. `--email`
   given and different from the stored email is an error (exit 2; use `login --session` to switch
   or `logout --session` first); the same email is accepted and a password source is ignored.
   Only for a freshness-requiring call (`POST .../api-keys`) on a kept session older than 15
   minutes (from
   `savedAt`), the CLI warns before sending; the controller's 403 stays the authority.
6. **Store:** a separate `session.json` beside `credentials.json`, one entry per controller
   `{ controller, email, cookie, savedAt }`, with the same directory, 0600 mode, no-link, owner
   and lock rules (`session.json.lock`). Entries are keyed and compared by the `normalizeBaseUrl`
   result; `email` is normalised as the login throttle does (`attempt.email.trim().toLowerCase()`,
   `packages/auth/src/login-throttle.ts`). `credentials.json` stays version 1, so older CLIs and
   the MCP server keep working. MCP and every key-only reader never open `session.json`.
   **Refresh (verified):** `getSession` in Better Auth 1.7.23
   (`better-auth/dist/api/routes/session.mjs`) refreshes a session older than `updateAge` with
   `internalAdapter.updateSession(session.session.token, { expiresAt, updatedAt })` and
   re-sets the cookie with the same token. The token and `createdAt` do not change (so
   freshness is unaffected); only the server-side expiry slides. The controller reads the session
   on every cookie request (`sessionPrincipal` in `api.ts`), so a kept session used at least every
   7 days lives on. Therefore the CLI never rewrites a stored cookie from a later `Set-Cookie`;
   a kept session is judged only from `savedAt` and the controller's 401/403. A session unused
   for 7 days is dead server-side; the next call gets 401, the entry is removed and the message
   says to sign in again, so a silently dead stored session is not possible.
7. **Cookie capture:** the sign-in response's `Headers.getSetCookie()` is searched for the
   session cookie (`better-auth.session_token`, or `__Secure-better-auth.session_token` on an
   https controller); only its `name=value` pair is kept and sent back unchanged, as the seed
   scripts do. A 200 with no session cookie is a sign-in error.
8. **Never with a key:** in the CLI command layer (the store does not read the environment),
   `--session` is refused with exit 2, before any prompt or request, whenever `LAUNCHPAD_API_KEY`
   is set, for `login`, `api` and `logout`. `LAUNCHPAD_CONTROLLER` alone is accepted for
   `--session`; the "set both or neither" error in `packages/client-core/src/operations.ts` is
   about key use and does not apply here. `api --session` sends no `Authorization` header;
   `api` without `--session` never reads `session.json`. The controller comes from
   `--controller`, else the selected `--profile` (only its `controller` and `organizationId` are
   used; its key is neither read nor sent), else `LAUNCHPAD_CONTROLLER`. With a session there is
   no "organization of the key" fallback: `{org}` needs `org use`, `launchpad.json` or
   `LAUNCHPAD_ORG`, else exit 2.
9. **Controller URL:** through the SDK's `normalizeBaseUrl`: https, or http only to `localhost`,
   `127.0.0.1` or `[::1]`; credentials, query and fragment refused; a path is kept as today.
   Anything else exits 2 before a prompt. The URL is printed before the prompt. Redirects are
   refused.
10. **Password input:** a hidden prompt, or `--password-file <path>`. The prompt requires
    `io.interactive` (stdin and stderr are TTYs); otherwise exit 2 before `readSecret`, which
    calls `setRawMode` without checking. The file is opened with `O_NOFOLLOW | O_NONBLOCK` (so a
    FIFO cannot block the open) and the descriptor is `fstat`ed: it must be a regular file (not a
    FIFO) owned by the user with no group or other permission bits, and is
    read with a 4096-byte cap. Exactly one trailing newline (`\n` or `\r\n`) is removed. The result
    must be 12 to 128 characters, checked before any request. The password never appears in argv,
    the environment, output, errors or `--verbose`. This needs a new `Io.readPasswordFile` (the
    existing `Io.readFile` follows links) and password-specific messages (`readSecret` says
    "too long to be a key").
11. **Origin and redaction:** the SDK session transport sends `Cookie` and `Origin: <controller
    origin>` and never `Authorization`, and reuses the key transport's timeout, bounded read,
    redirect refusal and error mapping. The cookie and password are redacted in the transport (no
    value in thrown errors, `--verbose` headers or `Set-Cookie`) and in the CLI output wrapper
    (`safeOutput` gains a filter for the cookie and password values of the current run).
12. **Errors:** 401 is "wrong email or password"; there is no retry inside an invocation. 429
    reads both `retry-after` (controller) and `X-Retry-After` (Better Auth), shows whichever is
    present, and does not wait. 400, including `client-address-unavailable`, is a plain
    non-retryable error. A 403 `forbidden-origin` on any call gets a hint: the controller accepts
    only the exact origin in its `LAUNCHPAD_BASE_URL`, so an http/https or proxy-host mismatch
    looks like this.
13. **Lockout, plainly:** each default-flow call is a new sign-in, and every sign-in attempt
    counts toward 5 per 60 s per (client IP, email) and 20 per 10 min per email
    (`packages/auth/src/login-throttle.ts`; Better Auth also limits `/sign-in/email` to 5 per
    60 s, `create-auth.ts`). More than 5 `api --session` calls a minute are throttled and also
    block that account's dashboard sign-in for the window. `--session` without `--keep` is for
    occasional use; batches use `--keep` (one sign-in) and then `logout --session`.
14. **Showing an issued key:** `api` redacts `lp_…` text, so a created key would be hidden.
    `--secret-file <path>` is allowed on any `api` call whose response may carry a `secret`. The
    file is created with `wx` mode 0600 **before** the request, so an existing file or a failed
    open means no request is sent. If the request fails, or succeeds without a `secret` string,
    the file is removed and the call is an error. On success the secret is the file's only copy;
    the screen shows the redacted response. A failed write after success cannot be undone: the
    error says the key exists and must be revoked in the dashboard or by `api`. Any
    `--secret-file` failure still signs the session out; the default flow always signs out.
15. **Freshness, summarized:** when no kept session exists, always fresh. A kept session is fresh
    for 15 minutes after sign-in. The rule and its server check are unchanged.

## Security notes

- A kept `session.json` is an account-wide bearer credential, valid until 7 days after its last
  use (the server expiry slides): whoever reads it
  can do everything that user can, and issue keys within 15 minutes of sign-in. Hence `--keep` is
  opt-in, the default is memory only, and `logout --session` revokes server-side. The password is
  never stored.
- CI exposure: key-only CI is unchanged; `--session` is refused when `LAUNCHPAD_API_KEY` is set.
  A runner with a password file could still sign in, which is the user's choice and is documented.
- No CSRF: a non-browser client has no ambient browser cookies; the Origin rule still protects
  browsers. Phishing: the controller URL is validated and printed before the prompt.
- Lockout: item 13.

## Steps

Each step is one commit and is safe to stop after. Steps 1 to 7 need no server, container or
database.

1. **`session.json` store in `packages/client-core`.** Separate file, same rules and lock,
   unknown version refused. Check: store tests (modes, links, owner, concurrent writers; entries
   keyed and compared by the `normalizeBaseUrl` result, so `https://x/` and `https://x` are one;
   `email` stored and compared normalised; `credentials.json` untouched and still version 1; the
   key-only readers never open the session file). Undo: revert (unused).
2. **SDK session transport.** `Cookie` and `Origin`, no `Authorization`, shared guards,
   `signIn` and `signOut`, cookie capture (item 7), 429 headers, 400/401/403 mapping with the
   `forbidden-origin` hint, URL table through `normalizeBaseUrl` (accepts `https://x`,
   `http://localhost:3000`, `http://127.0.0.1`, `http://[::1]:3000`; refuses `http://example.com`,
   `http://localhost.evil`, `https://u:p@x`, `https://x?q`, `https://x#f`, `ftp://x`). Check:
   hostile table, nothing sent on refusal, a 200 without a session cookie fails, the `__Secure-`
   name on https, and cookie and password absent from errors. Undo: revert.
3. **Password input.** `Io.readPasswordFile` and the prompt wiring with the `io.interactive`
   check. Check: symlink, FIFO (the open does not hang) or other non-regular file, wrong owner, mode 0640 and 0604 and
   0644, over 4096 bytes, CRLF and LF, empty, 11 and 129 characters, non-TTY refused before
   `readSecret`, and no password in any error. Undo: revert.
4. **`api --session` default flow and its command-layer rules.** Sign in, call (with
   `--paginate`), sign out; signals as in item 3; `--session` refused with `LAUNCHPAD_API_KEY`
   set (exit 2, nothing sent) for `api`; no `Authorization`; item 8's rules; `--email` required when no kept
   session exists; `safeOutput` cookie/password filter. Check: sign-out after success, HTTP error,
   thrown error, abort and a `--secret-file` failure; a failing sign-out warns and keeps exit 0; a second signal exits at
   once; SIGTERM and SIGHUP at the prompt restore raw mode, and so does the existing Ctrl-C
   (`\u0003`) rejection; handlers for SIGINT, SIGTERM and SIGHUP are removed afterwards; no `--email` and no entry exits 2
   naming `--email` with nothing sent; `LAUNCHPAD_CONTROLLER` alone (no key) is accepted and
   with `LAUNCHPAD_API_KEY` set the call is refused; nothing is written to disk; stderr, errors
   and `--verbose` never contain the cookie or password (CLI-side test with a response echoing
   them); a profile's key is neither read nor sent under `--session`; `{org}` without a selection
   exits 2 with no key fallback; the controller precedence is `--controller`, then `--profile`,
   then `LAUNCHPAD_CONTROLLER`; the throttle note appears in `--help`. Undo: revert.
5. **`--keep`, `login --session`, `logout --session`.** The same `LAUNCHPAD_API_KEY` refusal for
   `login` and `logout` (exit 2). Check: the store is written only with `--keep` or `login`;
   `login` prints the controller and email; `login --session` and `api --session --keep` with an
   existing entry each need credentials, sign the old server session out first (a failing
   sign-out warns) and replace the entry, including with a different `--email`; plain
   `api --session` with an entry uses it without prompting, works with no `--email`, accepts the
   same email in any letter case, and exits 2 for a different `--email`; `logout` with no entry says so and exits 0, ignoring `--email`; `logout` revokes then
   deletes, and deletes on sign-out failure; a 401 deletes the entry; the `savedAt` warning only
   for kept sessions and fresh-only requests; a later `Set-Cookie` never changes the stored cookie
   (the fake replies with a refreshed cookie; the file is unchanged). Undo: revert; a user's kept
   sessions go with `logout --session` or by deleting `session.json`.
6. **Worked examples as `program.spec.ts` tests against a fake `fetch`** (two scenarios; one
   session cannot do both):
    - _Operator creates an organization:_ sign in as the operator, `api --session -X POST
      organizations -f name=Demo -f slug=demo -f ownerEmail=ann@example.com --confirm` returns
      201; a non-operator session gets 403 (`POST /api/v1/organizations`,
      `createOrganization`).
    - _Owner issues a key:_ sign in as the owner, `api --session -X POST
      organizations/<id>/api-keys` with `name`, `scopes` and `expiresInDays`; a session with no membership gets 404; a kept
      session
      older than 15 minutes gets 403 "Sign in again". The controller's own tests cover the real
      role, freshness and 404 rules; the fake only checks that the CLI sends what they need
      (`Cookie`, exact `Origin`, no `Authorization`).
7. **`--secret-file`.** Check: the owner scenario of step 6 with `--secret-file` puts the secret
   in the file and not on screen; an existing file means no request is sent; the file exists with
   mode 0600 before the request; it is removed on a failed request and on a response without
   `secret`; a failed write reports the created key; the screen shows `lp_[redacted]`. Undo:
   revert.
8. **Docs:** `apps/cli/README.md` (flags, flow, best-effort sign-out, `--keep` risk, the lockout
   warning of item 13, the `forbidden-origin` note), `apps/controller/README.md` (who can use it),
   `docs/plans/cli-api-command.md` part 2 pointing here. Check: `omni -i run format` and
   `omni -i run check`, and the whole tree `omni -i run check test build`.

One commit per step. If one PR is too large, split it: steps 1 to 6 in the first, steps 7 and 8
in the second.

## Status

Built on branch `feat/cli-session-login`, one commit per step 1 to 7 and the docs in step 8. Deviations:

- Step 4's check lists a `--secret-file` failure, but that flag is step 7; its sign-out on failure is
  tested there (`apps/cli/src/secret-file.spec.ts`).
- Step 2 moved the shared request guards (`readBounded`, path and header checks, `nextLink`) into
  `packages/sdk/src/transport.ts` so both clients use one implementation; the key client's behavior and
  tests are unchanged, and it now also reads `x-retry-after`.
- `--keep` saves the entry right after the sign-in (before the call), then signs out the replaced
  session; if the save fails, the new session is signed out.
- The CLI test harness for `--session` is `apps/cli/src/session-harness.ts` (fake controller and terminal).
- Clarifications of item 8, as built: the controller is `--controller`, else the explicit profile (`--profile`,
  else `launchpad.json`'s `profile`), else `LAUNCHPAD_CONTROLLER`, else `LAUNCHPAD_PROFILE`, else the
  current profile. A profile's organization is used only if its controller is the one in use.
- A single signal guard covers the whole run whenever `--secret-file` is given (with or without a session, kept
  or not), and the file is removed only if it is still the file that was created.
- `logout --session` reports `signedOut` (true only if the controller confirmed, or answered 401 for an
  already-ended session) separately from `localEntryRemoved`; the exit code stays 0 and a failed sign-out
  still deletes the entry, with a warning that the controller may accept the cookie until it expires.
- The SDK takes the session cookie from a 200 sign-in as soon as the headers arrive, so a body that fails
  or stalls still leaves a cookie to sign out; a second concurrent `signIn` on one client is refused.
- With `--secret-file`, `--jq` and the screen get a copy of the response with the key replaced. Deliberate
  limit: removal of an unused secret file is by path after a device/inode check; a process that can write to
  the owner-only directory could still swap the path between check and removal (not closable in Node).
- Not run: nothing against a real controller; the packaged-client check (`test:packages`) and
  integration tests need Docker or the network.

## Undo

Steps 1 to 8 are additive: reverting the commits removes the commands. Because `credentials.json`
stays version 1, no older CLI or MCP breaks. Sessions a user kept stay in `session.json` after
a revert, where nothing reads them: they expire on the server within 7 days, and the user can
delete the file (document this in the revert note). No controller data or contract changes.

## Out of scope

- Controller changes, a device flow, a new token type or key scope (C and E).
- Operator access inside organizations; storing the password; silent renewal; session or password
  in `LAUNCHPAD_*` environment variables.
- Dedicated subcommands per organization action (`api --session` is the only entry), session
  listing, MCP use of sessions.

## Consequences

- A second credential type exists in the CLI, opt-in, on disk only with `--keep`.
- The "keys only" rule of the CLI has one documented exception, refused whenever a key is in
  the environment.
- Sign-out in the default flow is best effort; a killed process leaves a session until it expires.
- Lockout is shared with the dashboard, and each default-flow call is a new sign-in: more than
  5 `api --session` calls a minute throttle the account's dashboard sign-in too. Occasional use
  only; batches use `--keep`.

## What would reopen this

- Evidence that kept sessions leak, or users keep `--keep` sessions routinely.
- A need for unattended management of members or keys (revisits C or E).
- Better Auth offering a device flow the controller can adopt (C).
- Throttle changes that make a single scripted sign-in unsafe for the dashboard.

## Related

- [CLI `api` command plan](../plans/cli-api-command.md), part 2.
- [Organization roles, operator access and preview domain](organization-roles-and-operator-access.md).
- [Access and network guidance](../access.md).
- Code: `packages/auth/src/create-auth.ts`, `packages/auth/src/login-throttle.ts`,
  `apps/controller/src/server/api.ts`, `packages/client-core/src/store.ts`,
  `packages/sdk/src/client.ts`, `apps/cli/src/io.ts`, `tooling/local-seed.ts`,
  `tooling/experiments/acceptance/world.ts`.
