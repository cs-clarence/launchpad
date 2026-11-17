# Controller

For contributors to the TanStack Start dashboard and Elysia HTTP adapter.
Keep this page current when the entry points or runtime change.

- `src/routes/api.$.ts` mounts `src/server/api.ts` without starting another server.
- Services live in `@launchpad/services`, outside HTTP and UI frameworks.
- `src/styles.css` installs Skeleton 5, Tailwind 4, and the Cerberus theme.
- `Dockerfile` produces a non-root Bun runtime from Nitro's build output.
- `src/server/runtime.ts` composes configuration, the shared Kysely database,
  Better Auth and the API on first use.
- `src/admin/main.ts` is the operator command, run through Omni (see First run). Omni
  loads `apps/controller/.env.local` (copy `.env.local.example`) into `dev` and `admin`.

## Configuration

| Variable                          | Meaning                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                    | PostgreSQL connection string (required)                                                                                                                                                                |
| `LAUNCHPAD_AUTH_SECRET`           | Random secret, at least 32 characters (required)                                                                                                                                                       |
| `LAUNCHPAD_BASE_URL`              | Public controller URL; its origin is the only trusted origin (required)                                                                                                                                |
| `LAUNCHPAD_ENROLLMENT`            | `operator` (default) or `invitation` (requires SMTP)                                                                                                                                                   |
| `LAUNCHPAD_PUBLIC_SIGNUP`         | `false` by default; sign-up is a separate policy from SMTP                                                                                                                                             |
| `LAUNCHPAD_SMTP_URL`              | Optional; set with `LAUNCHPAD_EMAIL_FROM` to enable email recovery and invitations. `smtps://` or `smtp://` (STARTTLS required unless loopback); no query options                                      |
| `HOST` / `PORT`                   | Listen address and port of the built server (default `127.0.0.1`-style host, port `3000`)                                                                                                              |
| `LAUNCHPAD_DATA_DIR`              | Directory only the controller can write; uploaded archives are staged in `tmp/` and kept under `artifacts/` (default `.data/controller`). Mount durable storage here in production                     |
| `LAUNCHPAD_MAX_UPLOAD_BYTES` etc. | Optional upload limits, all positive integers; a set but invalid value stops startup. See [Artifact uploads](#artifact-uploads)                                                                        |
| `LAUNCHPAD_API_DOCS`              | `true` (default) serves the OpenAPI document and Scalar reference; `false` removes them                                                                                                                |
| `LAUNCHPAD_TRUSTED_PROXY`         | `false` (default): the TCP peer address is the client address. `true`: exactly one trusted proxy that appends to `X-Forwarded-For`; its rightmost entry is used. Never set `true` without such a proxy |

## API reference

The public `/api/v1` API is described by an OpenAPI 3.1 document at
`/api/openapi/json`, with a Scalar reference at `/api/openapi`. The reference is
generated from the same zod schemas the services validate with
(`packages/services/src/contracts.ts`, plus each service's input schema), and
integration tests parse live responses with those schemas, so documentation
cannot drift from behaviour. Scalar's script is published from this origin from
the pinned `@scalar/api-reference` package (`vite.config.ts`); no third-party
script runs next to the session cookie. Better Auth's `/api/auth/*` endpoints are
not part of the document.

To document a new route, add an entry to `docs` in `src/server/openapi.ts` and pass it as
the route's `detail`. In Elysia 2 RC the hook goes **before** the handler:
`.get(path, { detail: docs.x }, handler)`; the legacy handler-first order throws.

## First run

Copy `.env.local.example` to `.env.local` here and edit it; Omni loads it for `dev` and
`admin`. Take a `pg_dump` before every migrate: migrations are forward-only, so rolling
back means stopping the controller and restoring the dump. Stopping management access
never touches Dokku workloads.

Operator commands run as an Omni task whose command and options are named arguments.
Passwords come from a file only you can read (mode 600) or from piped stdin, never from
an argument or the environment. Omni does not forward piped stdin, so use a file:

```sh
omni -i run admin -p @launchpad/controller -a command=migrate           # forward-only, explicit
omni -i run admin -p @launchpad/controller -a command=setup \
  -a "options=--email you@example.com --password-file /run/secrets/launchpad-operator"
omni -i run dev -p @launchpad/controller                                 # dev server
```

Run directly, from this directory, the same commands are `bun run admin migrate` and
`pass show launchpad/operator | bun run admin setup --email you@example.com`.

Sign-in is throttled per client and email, and per email across clients (so someone
who knows an address can temporarily lock that account out of sign-in; this is an
accepted trade-off); Better Auth
also limits each client address. `setup` creates the one instance operator, once, with the password from stdin.
`reset-password --email <email>` (new password from `--password-file` or stdin) is the
local recovery path: it replaces the password, revokes all of that user's
sessions and API keys, and writes an audit event with revoked-session/key counts.
It is a host command, not an HTTP endpoint.
The controller never migrates on startup. There is no default password.
Provision people and organizations offline:

```sh
omni -i run admin -p @launchpad/controller -a command=create-user \
  -a "options=--email ann@example.com --name Ann --password-file /run/secrets/ann"
```

Then sign in as the operator and create an organization in the dashboard, naming
an existing user as its first owner. The operator gets no access inside the
organization; owners and admins add existing users by email. Roles are `owner`,
`admin`, `deployer` and `viewer` (see
[the decision](../../docs/decisions/organization-roles-and-operator-access.md)).

Access granted by email (an organization's owner, or a member added by address) only goes to
an account whose address was verified or that the operator provisioned, never to one that
registered itself. This does not depend on the current `LAUNCHPAD_PUBLIC_SIGNUP` value, so
turning sign-up off does not make accounts registered earlier any more trustworthy; invite
such an address instead.

### Email (optional)

With `LAUNCHPAD_SMTP_URL` and `LAUNCHPAD_EMAIL_FROM` set, a forgot-password page
appears and password reset mail is sent, but only to addresses that are
**verified**. An address becomes verified when its owner accepts an emailed
invitation; operator-provisioned addresses stay unverified and are recovered with
`reset-password`. With `LAUNCHPAD_ENROLLMENT=invitation`, owners and
admins invite people by email (7-day, single-use link; only a hash is stored). A
new person creates their own account from the link; an existing user must be
signed in as the invited address. SMTP alone enables neither invitations nor
public sign-up. Turning email on or off never changes accounts, memberships or
sessions. If mail cannot be sent, an invitation is revoked and the API returns 502.

Run checks from the repository root as described in
[CONTRIBUTING.md](../../CONTRIBUTING.md). Milestone 1's independent security review is
complete; keep `LAUNCHPAD_API_DOCS=false` on internet-facing installs unless you want
the API shape public, and put the controller behind HTTPS before exposing it.

## API keys

Owners and admins manage keys on the organization page. Choose explicit scopes,
expiry (at most 365 days) and optional project restrictions. The default is
organization/project read access. `member:read` includes all members' email
addresses; the UI does not offer the reserved `project:delete` scope.

Issuing requires a sign-in from the last 15 minutes. Freshness uses the server's
flag and remaining duration, not a comparison with the browser's clock. The page provides checked
sign-out and sign-in guidance for an old session. A successful issue reveals the
key once: save it before selecting **I saved it — dismiss**. Copying requires an
explicit click. Key values are held only in component state, not loader data,
URLs or browser storage, and are removed from the field on pagehide; erasure
from all JavaScript memory or the clipboard is not guaranteed.

If issuance cannot be confirmed (network failure, server error or invalid reveal),
the page does not retry. Refresh the metadata list and inspect same-name keys
whose IDs were absent before the attempt. Names are not unique: verify the prefix,
creator and creation time before revoking. Returning from bfcache refreshes the
list; an interrupted reveal retains only its ID/name/prefix as a notice, never its
value. A successful refresh is required before acknowledging another attempt.
Revocation asks for confirmation with the name and key prefix.
Authenticated organization pages and server-function responses are `no-store`.

An owner or admin issues organization API keys from the API (`POST
/api/v1/organizations/{orgId}/api-keys`, signed in). The secret is shown once. Automation
sends `Authorization: Bearer lp_…`. A key is limited to its organization, to the scopes it
was given (read and project actions only), optionally to named projects, and never exceeds
its creator's current role; it stops working when it expires, is revoked, or its creator
leaves the organization. Keys cannot manage keys, members, invitations or organizations.

Project-restricted keys cannot be issued with `project:create`. Both email and
operator password recovery revoke the user's API keys; removing a member also
deactivates and audits their active keys. Recovery audit events count revoked keys.
The emailed-reset callback runs after Better Auth commits its password change.
If the callback fails, the response reports failure but the password/token change
may already have committed. Key revocation precedes its audit insert, so audit
failure does not restore keys. Use operator recovery if necessary.

## Artifact uploads

`POST /api/v1/organizations/{orgId}/artifacts` (signed in; deployers and above; API
keys are not accepted yet) stores a static site. The body is the archive itself, a
`.tar.gz`, sent with `Content-Type: application/gzip` and a `Content-Length`. It is
not multipart: the caller is authorized first, then the body streams to a private
staging file (never buffered in memory), is hashed, validated and finalized.

Accepted: regular files and directories, with `index.html` at the root. Refused
with 422: links of any kind, devices, absolute or `..` paths, backslashes and control
characters, duplicates (including names that differ only by case), a file used as a
directory, more than the allowed entries or nesting, secrets (`.env*`, `.git`,
`.ssh`, `.aws`, `.npmrc`, `.htpasswd`, `id_rsa`-style keys, `*.pem`, `*.key`,
`*.p12`), a nested compressed layer, and an archive that expands beyond the limit
(counted while decompressing, so a bomb is stopped early). The CLI should leave
secrets out before uploading; the server refuses rather than silently dropping them.

| Variable                           | Default             | Limit                                                          |
| ---------------------------------- | ------------------- | -------------------------------------------------------------- |
| `LAUNCHPAD_MAX_UPLOAD_BYTES`       | 52428800 (50 MiB)   | Upload size; a larger declared length is a 413 before any read |
| `LAUNCHPAD_MAX_EXPANDED_BYTES`     | 209715200 (200 MiB) | Decompressed size                                              |
| `LAUNCHPAD_MAX_ARCHIVE_ENTRIES`    | 5000                | Files and directories                                          |
| `LAUNCHPAD_MAX_ARCHIVE_DEPTH`      | 16                  | Path depth                                                     |
| `LAUNCHPAD_UPLOAD_TIMEOUT_SECONDS` | 300                 | Total upload time; 408                                         |
| `LAUNCHPAD_MAX_ARTIFACTS`          | 20                  | Stored artifacts per organization                              |
| `LAUNCHPAD_MAX_CONCURRENT_UPLOADS` | 2                   | Uploads in flight per organization (8 in total)                |

### Preview lifetimes

Every new preview gets an expiry (`expiresAt` in the API; `null` means never):
`LAUNCHPAD_DEFAULT_TTL` (default `7d`) unless the request gives a `ttl` such as `24h`, which
may be at most `LAUNCHPAD_MAX_TTL` (default `30d`). `"ttl": "none"` is refused unless
`LAUNCHPAD_ALLOW_NO_EXPIRY=on`. Durations are a whole number and `s`, `m`, `h` or `d`; a set
but invalid value stops the controller at startup, as does a default longer than the maximum.
Previews created before lifetimes existed have no expiry until given one. **Nothing is
deleted unless the worker runs the lifecycle** (`LAUNCHPAD_LIFECYCLE=on` on the worker,
default off): then expired previews are deleted, and stored archives are collected after
`LAUNCHPAD_ARTIFACT_RETENTION` (default `7d`); see `apps/worker/README.md`.
Retention must be at least `1h`. The first time the worker enables lifecycle for this
database, already-overdue previews get a one-time 24 h grace.

### Instance status

`GET /api/v1/status` is for the instance operator and needs a session (an API key cannot read
it, whatever its scopes; an organization owner who is not the operator gets 403). It returns
what an operator needs to know whether the instance is healthy, as counts and ages only (no
ids of previews, names, or text that came from a remote system):

- `dependencies`: the database (`ok` if the request got an answer) and the data directory (`ok`,
  `missing`, `not-writable`, `not-a-directory`, or `not-checked` while deployments are off). The
  controller creates the directory (on its first request after starting) with deployments on.
- `controller`: whether deployments and the lifecycle are on here, and `deletionsAccepted` (both
  are: the controller takes new deletions).
- `workers`: each worker that has reported, with its version, whether it runs the lifecycle, when it
  started, how many seconds ago it reported and whether that is `live` (within the last minute).
  A worker reports when it starts and at least every 10 s, on a timer of its own, so one that is
  busy building still shows as live; rows of workers silent for a day are forgotten.
- `deployments` (queued, running, held for an administrator, age of the oldest queued and of the
  longest-unmoved running one), `expiry`
  (previews past their expiry and not yet claimed), `deletions` (waiting, held) and `artifacts`
  (stored count and bytes).
- `warnings`, in plain words: work waiting with no live worker (expiry and deletion only count where
  the lifecycle is on); the controller accepts deletions but no live worker has the lifecycle on (a
  deletion would be accepted and never run), or the other way round; the lifecycle on without
  deployments; a deployment that has not moved for an hour (a stuck worker still beats, so this is
  how it shows); deployments or deletions that need an administrator; a data directory that is
  missing, read-only or not a directory.

There is no dashboard panel for it yet.

### Deploying from the dashboard

The previews page has a **Deploy a site** form (a preview's own page has **Deploy a new
version**) for deployers and above, when deployments are on. It takes the built site as a
`.tar.gz` (`tar -czf site.tar.gz -C dist .`), not a directory: unlike the CLI, a browser does
not pack a directory, so link and secret-looking-file refusals are the server's (the upload is
validated while it streams). It makes the CLI's three calls with your session: create the
preview (name, project, optional lifetime), upload the archive, queue the deployment, then opens
the preview page, which follows it. Each call carries an idempotency key that stays the same on a
retry, and a retry after a failure resumes from the step that failed (a created preview or a
stored archive is not made twice). The browser's checks of name, file type and size only save a
round trip; the server's limits (`LAUNCHPAD_MAX_UPLOAD_BYTES`, the artifact ceiling) decide.

### Dashboard preview page

`/orgs/:orgId/previews` lists previews with when each expires; a preview's page
(`/orgs/:orgId/previews/:previewId`) shows its lifetime and the controls its role may use:
**Extend** (deployer and above), **Delete this preview** (deployer and above, with a
confirmation; hidden, with a note, when deleting is not turned on), and for a deletion
that needs a person, **Try the deletion again** / **The app is already gone** (administrators
and owners, with a confirmation; the API also needs a sign-in from the last 15 minutes). A
deletion in progress refreshes itself, and a preview deleted while its page is open
shows the finished deletion (a page watching a deletion in progress looks again by itself; one that was not must be reloaded). Where the lifecycle is off nothing expires, so the page says so
instead of showing a countdown, and the lifetime choices are limited to the server's maximum. Buttons are hidden for roles that could not use them,
but only the API enforces permissions. A preview that is being deleted shows its deletion, even
when expiry started it.

### Preview lifecycle API

All paths below are under `/api/v1/organizations/:orgId`. Mutations require deployer
or higher unless noted; API keys also need the named scope and access to the owning
project. Cookie mutations keep the same-origin requirement.

| Method and path                                                                                       | Result                                                                                  | Key scope                                              |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `POST /previews/:previewId/extend` with `{ "ttl": "24h" }`                                            | 200 preview with resulting `expiresAt`                                                  | `preview:deploy`                                       |
| `DELETE /previews/:previewId`                                                                         | 202 `{ operationId, state: "deleting" }`                                                | `preview:delete`                                       |
| `GET /previews/:previewId/deletion`                                                                   | 200 the preview's latest deletion, whoever started it (a person or expiry); 404 if none | `preview:read`                                         |
| `GET /deletions/:operationId`                                                                         | 200 deletion status, reason, fixed failure text, creation/finish times                  | `preview:read`                                         |
| `POST /deletions/:operationId/resolution` with `{ "outcome": "retry" }` or `{ "outcome": "deleted" }` | 200 `{ ok: true }`                                                                      | Session only: admin/owner, signed in within 15 minutes |

Extension accepts `Idempotency-Key`: repeating it does not extend again and returns
the current preview, not a snapshot of the original response; a different request
with that key is 409. Extension never shortens an expiry and is capped at the
instance maximum from now. Extending a never-expiring preview with a duration **gives it
an expiry**. Once deleting, extension is 409 (a replay of an earlier key returns the current
preview).

A deleted preview is 404 for extension, like the other preview routes. A deletion's `failure` is a
note from the last attempt, not necessarily a failure: read it with `status` (the codes are
listed in the OpenAPI schema); only `reconciliation-needed` needs a person.

Deletion cannot be undone. It only queues work; it does not wait for Dokku. Set
`LAUNCHPAD_LIFECYCLE=on` and `LAUNCHPAD_DEPLOYMENTS=on` in both controller and worker (the
worker does nothing without deployments);
the controller refuses a new deletion with 409 unless both are on. Repeated DELETE
returns the same operation while deleting, without needing an idempotency key; after
deletion it is 404. Poll the operation: `queued`, `running`, `succeeded`, or
`reconciliation-needed`. For reconciliation, check the host first: `retry` queues
another attempt; `deleted` trusts the administrator and does not remove images.

A length-less (chunked) upload is a 411. An identical archive already stored for the
organization is reused (`reused: true`); archives are deduplicated within an
organization only. Stored archives stay until the worker's lifecycle collects them (off by default; after
`LAUNCHPAD_ARTIFACT_RETENTION` and only when no live preview needs them), so until then an
organization at its ceiling is refused even for an identical archive (redeploy an
existing artifact by id instead); collected archives no longer count toward the ceiling. A stale staging file from a crash is swept at the
next start. `/_serverFn/**` request bodies are bounded to 64 KiB like the rest of the API.
