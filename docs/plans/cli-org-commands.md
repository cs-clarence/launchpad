# CLI commands for organization, member, invitation and key management

Dedicated `launchpad` subcommands for the session-only actions that `launchpad api --session`
already reaches. Builds on [the session login decision](../decisions/cli-session-login.md)
(accepted and built) and [the `api` command plan](cli-api-command.md).

## Assessment

- **Kind:** medium work. A new public CLI surface on machinery that exists (session flow,
  `--secret-file`, `--confirm`, output conventions). No controller, database or contract change,
  no new transport, no new credential type.
- **Risk tier:** High. The commands issue and revoke credentials and change membership using the
  user's password-backed session. An independent review of this plan precedes step 1.
- **How much changes:** `apps/cli`, `packages/sdk` (typed session methods), docs.
- **Unknowns:** none that block step 1. **Open questions:** none.
- **Move up a kind if:** a controller or contract change is needed (a new endpoint, a lookup by
  email or slug, a scope, or moving the request schemas into `@launchpad-kit/contracts`), the
  commands must work with a key, or the session flow needs a change beyond the step 1 extraction.

## Goal and done

An operator or an organization owner/admin can create an organization, list/add/remove members,
create/list/revoke invitations and list/issue/revoke API keys from a terminal, without
hand-writing `launchpad api --session -X POST ...`. Each command is one API call using the
existing session flow, needs `--confirm` for a write, prints a table or `--json`, and never prints
a secret. Done when the worked example passes as `program.spec.ts`-style tests against a fake
`fetch` that records every request, `omni -i run check test build` is green, and the docs below
are updated.

## Scope

Ten commands: nine session-only, plus `member list`, which a key holder can already call
(`member:read`) but is session-only here by deliberate choice (a key holder uses `api`). It is in
the set because `member remove` needs the `userId` it prints.

| Command         | One call (`/api/v1`)                         | Session caller that succeeds                                                                                                   |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `org create`    | `POST /organizations`                        | the instance operator only; the operator gets no membership                                                                    |
| `member list`   | `GET /organizations/:org/members`            | any member                                                                                                                     |
| `member add`    | `POST /organizations/:org/members`           | owner/admin; an admin may assign only deployer and viewer                                                                      |
| `member remove` | `DELETE /organizations/:org/members/:userId` | owner/admin, or a member removing themselves; last owner: 409                                                                  |
| `invite create` | `POST /organizations/:org/invitations`       | owner/admin; 404 "Invitations are not enabled." without enrollment/SMTP; 502 if mail fails (the invitation is already revoked) |
| `invite list`   | `GET /organizations/:org/invitations`        | owner/admin                                                                                                                    |
| `invite revoke` | `DELETE /organizations/:org/invitations/:id` | owner/admin                                                                                                                    |
| `key list`      | `GET /organizations/:org/api-keys`           | owner/admin                                                                                                                    |
| `key issue`     | `POST /organizations/:org/api-keys`          | owner/admin **and a session signed in within 15 minutes**; 409 at 100 active keys (`MAX_ACTIVE_KEYS_PER_ORGANIZATION`)         |
| `key revoke`    | `DELETE /organizations/:org/api-keys/:id`    | owner/admin; idempotent                                                                                                        |

Checked in `apps/controller/src/server/openapi.ts`, `api.ts` and `packages/services/src/`. A
non-member gets 404.

Out of scope: `project create` (key-allowed: `api` with a key reaches it); `invite
preview|accept` (public token flow; accepting for a new person needs a new password); slug
lookup of organizations; role editing and organization deletion (no endpoint); any controller,
contract or database change; MCP; a key or `LAUNCHPAD_API_KEY` for these commands; printing a
secret.

## Command surface

New groups are singular (`member`, `invite`, `key`), like `app`; `org create` joins `org`.
`org list|use` and `projects list` stay key commands.

```sh
launchpad org create --name <name> --slug <slug> --owner-email <address> --confirm
launchpad member list
launchpad member add --user-email <address> --role <role> --confirm
launchpad member remove <user-id> --confirm
launchpad invite create --to <address> --role <role> --confirm
launchpad invite list
launchpad invite revoke <invitation-id> --confirm
launchpad key list
launchpad key issue --name <name> --scope <scope>... [--project <id>...] --expires-in-days <n> --secret-file <path> --confirm
launchpad key revoke <key-id> --confirm
```

Shared by all ten, with the meaning `api` gives them: `--email` (the signing-in account; optional
with a saved session, a different one exits 2), `--password-file`, `--keep`, `--controller`, the
global `--profile` and `--json`. With `LAUNCHPAD_API_KEY` set every command exits 2 before any
prompt or request, and no `Authorization` header is ever sent.

- **`--org <id>`** (all but `org create`). Precedence: `--org`, then the nearest
  `launchpad.json` `organization` (read with `readWorkspace`, as `api` does), then
  `LAUNCHPAD_ORG`, then the selected profile's organization (the last two via
  `resolveSessionTarget`, which never reads `launchpad.json` and has no key fallback). **ID only:**
  organization IDs are UUIDs (`randomUUID()` in `createOrganization`), so a value that is not
  UUID-shaped, such as a slug, exits 2 with a hint to use the ID (from the dashboard, or `launchpad api --session
  organizations`, since `org list` needs a key these users may not have); there is no lookup,
  so each command stays one call. A slug in `launchpad.json` or in the profile therefore fails
  for these commands, whereas `api` resolves it with `GET /organizations`: a deliberate
  difference, stated in the README and the help. None found: exit 2, nothing sent.
- **`--confirm`** is a plain flag on the seven writes (all but the `list` verbs); without it, exit
  2 before any prompt or request.
- **Acting line.** Once per command, after sign-in (or from the kept session's stored email) and
  before the first API request, stderr gets `Acting as <email> on <controller>, organization
  <id>` (for `org create`, without the organization). Never on stdout, so `--json` stays
  machine-clean. With the default flow the sign-in has already happened when the user sees it,
  so the line is an audit trail, and a real guard only for a kept session (where nothing is asked
  first); it is not an interrupt, and the README must not claim it is. `--confirm` stays a plain
  flag and is the intent check. `member remove` of your own ID
  (leaving) is allowed by the controller and is not special-cased. `key revoke` of a key that
  `key list` printed is the normal flow.
- **Naming.** `--email` always means the acting account. The target is `--user-email` (`member
  add`), `--to` (`invite create`) or `--owner-email` (`org create`, the API field name).
- **`--role`** is checked against `ORGANIZATION_ROLES` and **`--scope`** (repeatable) against
  `API_KEY_SCOPES`, both from `@launchpad-kit/contracts`. Role limits are the controller's (403 is
  shown), not duplicated.
- **`key issue`:** `--project <uuid>` repeatable, refused with `project:create` (the contract's
  rule); `--expires-in-days` required, 1 to 365 (`MAX_KEY_LIFETIME_DAYS`), no default;
  `--secret-file` required.
- Arguments are IDs as the `list` verbs print them; no lookup by email or name. `<user-id>` is
  only path-checked (Better Auth IDs are not UUIDs); invitation and key IDs must be UUIDs.

Request bodies (the shapes the controller validates in `packages/services`):

| Command         | Body                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `org create`    | `{ name, slug, ownerEmail }` ← `--name`, `--slug`, `--owner-email`                                     |
| `member add`    | `{ email, role }` ← `--user-email`, `--role`                                                           |
| `invite create` | `{ email, role }` ← `--to`, `--role`                                                                   |
| `key issue`     | `{ name, scopes, projectIds?, expiresInDays }` ← `--name`, `--scope`, `--project`, `--expires-in-days` |

**Output.** Human mode uses the `text()` table helper, headers first, as `org list` does, and `No
<things>.` when empty; `--json` prints the response body as pretty JSON.

| Command         | Output                                                                     |
| --------------- | -------------------------------------------------------------------------- |
| `org create`    | `Created organization <slug> (<id>) with owner <email>.`                   |
| `member list`   | `USER ID  EMAIL  NAME  ROLE`                                               |
| `member add`    | `Added <email> to <org> as <role>.`                                        |
| `member remove` | `Removed <user-id> from <org>.`                                            |
| `invite create` | `Invited <email> as <role> (<id>). The invitation was emailed.` (no token) |
| `invite list`   | `ID  EMAIL  ROLE  CREATED  EXPIRES`                                        |
| `invite revoke` | `Revoked invitation <id>.`                                                 |
| `key list`      | `ID  NAME  PREFIX  STATUS  SCOPES  PROJECTS  EXPIRES  LAST USED`           |
| `key issue`     | `Issued key <name> (<id>), expires <date>. The secret is in <file>.`       |
| `key revoke`    | `Revoked key <id>.`                                                        |

`key issue --json` shows `secret` replaced by `"[written to <file>]"`. Exit codes are the existing
ones (`errors.ts`): 2 usage, 3 for 401/403, 4 for 404, 5 transport or unexpected answer, 6 store,
and **1 for 409, 422 and 502** with the controller's message (already a member, last owner,
duplicate slug, too many active keys).

## Approach

**One shared session runner, then thin commands.** The session wiring lives in
`api-command.ts`'s `sessionBackend` closure. Step 1 moves it unchanged into
`apps/cli/src/session-run.ts` as `runWithSession({ needsFresh, ... }, ({ client, email, controller }) => ...)`: it
resolves the target, uses a saved session or a `SessionFlow` (honouring `--email`, `--keep`, the
removal of a 401 entry, `withSession` sign-out and cookie/password redaction), and warns when a
saved session is older than 15 minutes and `needsFresh` is true. `api` keeps computing
`needsFresh` from its path regex (`POST organizations/:id/api-keys`); `key issue` passes `true`,
the others `false`. The organization is the caller's resolved `--org`, and the acting line is
printed by the runner's callback wrapper, once, with those three values. The caller passes in its `SignalGuard` (as `api` does today), so the guard
that already covers `--secret-file` is unchanged; the secret-file creation and removal code moves
to a shared helper that takes the same guard. The existing specs (`api-session`, `session-keep`,
`secret-file`, `api-command`) passing unchanged are the "behavior unchanged" check.

**Typed session methods, hand-typed inputs.** The contracts package has `createApiKeySchema` and
every response schema, but **not** the other request schemas: `createOrganizationSchema`,
`addMemberSchema` and `createInvitationSchema` live in `packages/services` (re-exported to the
controller by `services/src/contracts.ts`), and the SDK depends on contracts, not services.
Decision: no contract move. Step 2 adds to `packages/sdk/src/session.ts` `organizations.create`,
`members.list|add|remove`, `invitations.create|list|revoke` and `apiKeys.list|issue|revoke`
with **hand-typed inputs** (the body shapes above) and the controller as the validator. They use
the session client's existing `apiTransport`/`rawRequest` (cookie and `Origin`, timeout, redirect
refusal, redaction unchanged) and parse responses with the contracts' response schemas through
the key client's `loose()` wrapper. Path segments use `encodeURIComponent`; IDs are checked as
path-safe once. An unparseable answer is the existing "unexpected answer" error (exit 5).

**`key issue` and the secret.** The file is created exclusively (0600) before the request, as
`api --secret-file` does. `apiKeys.issue` takes an `onSecret(secret)` callback that receives the
`secret` string read from the raw body **before** schema parsing, and the CLI awaits the file
write inside it, so the secret is on disk before any parse problem is reported. After the
request was sent:

- 2xx with a `secret`: written to the file first; a later parse problem is reported as a warning
  that the key exists (id from the body if readable) and is in the file.
- 4xx other than 408 and 429: the controller refused; the file is removed (no key exists).
- A transport failure, timeout, abort or signal, a 408, 429 or 5xx, or a 2xx with no capturable `secret`: the
  key **may exist**. The empty file is removed and the message is: `The key may exist: run
  "launchpad key list" and revoke it.` Exit code of the underlying error.
- A write failure after capture keeps the existing message that the key exists and must be
  revoked.

**Each command is one call.** No slug, email or membership lookup.

Rejected: thin wrappers over `api` (flags become field-name strings, responses stay untyped text,
the freshness check keys off a path regex); a generated client (a generator and package for ten
calls); a new transport or controller endpoints (fixed by the decision record); re-implementing
the role matrix (the controller is the only authority); an implicit `--confirm` on a terminal (the
existing destructive commands and `api` require the flag); an optional `--secret-file` (`lp_...`
is redacted everywhere, so an unprinted key would be lost).

## Worked example

Fake controller, recorded `requests`; the fake checks what the CLI sends (`Cookie`, exact `Origin`,
no `Authorization`, one request per command besides sign-in and sign-out). The controller's own
tests own the role rules.

1. **Operator creates an organization with an owner.** `launchpad org create --email
   op@example.com --password-file pw --name Demo --slug demo --owner-email ann@example.com
   --confirm` sends `POST /api/v1/organizations` with `{name, slug, ownerEmail}` and prints the
   ID. Without `--confirm`, with a key in the environment or with no `--email`: exit 2, zero
   requests. A non-operator: 403, exit 3. An unknown owner: 422, exit 1 ("The owner must be an
   existing user"). A duplicate slug: 409, exit 1.
2. **Owner issues a key to a file, lists, revokes.** After `launchpad login --session --email
   ann@example.com`, `launchpad key issue --org ORG --name ci --scope project:read --scope
   app:deploy --expires-in-days 30 --secret-file ci.key --confirm`: `ci.key` exists (0600) before
   the request and holds `lp_...` after; the screen never shows it. `key list` shows it `active`;
   `key revoke KEY_ID --confirm` prints `Revoked`; `key list` shows `revoked`; a second revoke
   exits 0.
3. **Members.** `member list`, `member add --user-email bob@example.com --role deployer
   --confirm`, `member remove USER_ID --confirm`. Last owner: 409, exit 1, "An organization must
   keep at least one owner". An admin adding an admin: 403, exit 3. Already a member: 409.
4. **Invitations.** `invite create --to carol@example.com --role viewer --confirm`, `invite list`,
   `invite revoke ID --confirm`. Enrollment or SMTP off: 404, exit 4, "Invitations are not
   enabled." Mail failure: 502, exit 1.

Edge cases, each a test:

- **Stale session, `key issue`:** a saved session older than 15 minutes prints the existing
  warning; the 403 "Sign in again to do this." exits 3 with the hint to run `launchpad login
  --session`. Without `--keep` each call signs in fresh.
- **Wrong account or organization:** a different `--email` from the saved one exits 2, nothing
  sent; another organization's owner gets 404 (exit 4). Every command prints the `Acting as ...`
  line on stderr and never on stdout (`--json` stdout parses as JSON).
- **`--org` shape:** a slug, an empty value or a non-UUID exits 2 with the ID hint and zero
  requests; precedence `--org` > `launchpad.json` > `LAUNCHPAD_ORG` > profile is tested, and a
  slug in `launchpad.json` or the profile is refused the same way (no `GET /organizations`), with the hint naming `launchpad api --session organizations` and the dashboard, not `org list`.
- **`key issue` after the request was sent:** (a) 201 with a `secret` but a body that fails the
  response schema: the file holds the secret, the output says the key exists; (b) connection
  dropped, 408, 429, 5xx or 2xx without `secret`: the file is removed and the "may exist, run `key list`"
  message appears; (c) 400, 403, 404, 409 or 422: file removed, no such message; (d) 409 at 100 active keys: exit 1 with
  the controller's message.
- **Key env set:** refuses all ten, exit 2, nothing sent.
- **Throttling:** 429 shows `retry-after` or `X-Retry-After` and exits 1, no retry.
- **Bad input before any request (exit 2, zero fetches):** unknown role or scope, no `--scope`,
  `--expires-in-days` outside 1 to 365, `--project` with `project:create`, non-UUID `--project`,
  an existing secret file, a path-unsafe ID, a malformed email.
- **Secrets:** the password, cookie and any `lp_...` string are absent from stdout, stderr,
  `--json` and errors in every test; the secret exists only in the file.

## Steps

One PR with one commit per step, each safe to stop after and testable with fakes only (a fake
`fetch` that records every request, the existing `session-harness.ts`; no server, container or
database). A split is not needed: steps 3 to 5 are small additive groups over steps 1 and 2, and
each commit carries its own tests and docs so it can be reviewed alone.

1. **Extract `runWithSession` and the secret-file helper from `api-command.ts`** (interface under
   Approach); `api` uses them. Riskiest: it moves credential code, so it is first and changes
   nothing observable. Check: `api-session`, `session-keep`, `secret-file` and `api-command`
   specs pass unchanged; `omni -i run check test -p @launchpad-kit/cli`. Undo: revert.
2. **Typed session methods in `packages/sdk/src/session.ts`** with hand-typed inputs. Check: each
   method sends the right method, encoded path and body, `Cookie` and `Origin`, no
   `Authorization`; `onSecret` receives the secret before parsing; 401/403/404/409/422/429/502 and
   a malformed response map to the existing errors; no cookie or password in errors; hostile IDs
   send nothing. Undo: revert (additive).
3. **`key` commands**, the shared `--org`/`Acting as`/`--confirm` plumbing, and the README "Key
   management" section. Check: worked example 2 and the `key issue` and `--org` edge cases. Undo:
   revert.
4. **`org create` and `member` commands** and their README section. Check: worked examples 1 and 3. Undo: revert.
5. **`invite` commands** and their README section. Check: worked example 4 and that no output
   contains a token. Undo: revert.
6. **Help text and remaining docs.** Each command's `--help` names its API call and carries the
   lockout note: every command without `--keep` or a saved session is a new sign-in, so `member
   list` then `member remove` is two sign-ins, and more than 5 a minute also blocks that account's
   dashboard sign-in; for batches use `--keep`, then `logout --session`, and a kept session goes
   stale for `key issue` after 15 minutes (the 403 tells the user to sign in again). Docs: the
   decision record addendum below, `apps/controller/README.md` (the paragraph naming `api
   --session` also names these commands), one pointer in `docs/local-quickstart.md`, and the
   status line of part 2 in `docs/plans/cli-api-command.md`. Check: a test that every `--help`
   names its call and the lockout note; `omni -i run format check`, then `omni -i run check test
   build`. Undo: revert.

### Addendum to the decision record (applied in step 6)

> **Addendum, 2026-11-26.** The user accepted dedicated subcommands for session-only actions,
> which this record listed as out of scope for the first slice. In: `org create`, `member
> list|add|remove`, `invite create|list|revoke`, `key list|issue|revoke`. Out: `invite
> preview|accept`, `project create` and any controller change. They reuse items 1 to 15, extending
> item 14 for `key issue`: the secret is captured from the response before it is parsed, and an
> ambiguous failure after the request was sent (transport failure, 408, 429, 5xx, no secret)
> removes the file and says the key may exist and to run `key list`. They are specified in
> [the plan](../plans/cli-org-commands.md). Session listing and MCP use of
> sessions stay out of scope.

The "Dedicated subcommands per organization action" line under "Out of scope" is annotated to
point at it.

## Risks

- **Riskiest (step 1):** moving session code; mitigated by a pure move gated by the existing
  specs.
- **A destructive call against the wrong target:** explicit `--confirm`, ID-only `--org`, and the
  `Acting as ...` line (an audit trail, a guard only for kept sessions).
- **A lost or leaked key:** the secret is captured before parsing, written first, and ambiguous
  failures say to run `key list`; tests assert absence from all output.
- **Throttling and dashboard lockout:** documented in help and README; a 429 is not retried.
- **Surface as a contract:** the commands follow the controller's OpenAPI and the README says so;
  more verbs need a new plan.

## Verification and undo

`omni -i run check test build` at the end, and each step's check. Not run here: the packaged-client
check (`test:packages`, needs the network) and anything against a real controller. Undo is per
step and additive; no data, controller or contract effects.

## Ready-to-build check

Against `docs/guidelines/planning/ready-to-build.md`: goal, scope and finish line are checkable
(Goal and done, worked example); no open question blocks step 1; the riskiest part is step 1;
every step has a check and an undo and step 1 names the file, the function and the specs; costly
choices are decided (hand-typed SDK inputs with no contract move, ID-only `--org`, flag names,
required `--secret-file`, exclusions) and recorded in the addendum; interfaces are specified
(command and body tables, SDK method list, runner signature); the High-risk review gate applies.

## Status

Revised after independent review; not started.
