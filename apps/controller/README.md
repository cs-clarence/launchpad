# Controller

For contributors to the TanStack Start dashboard and Elysia HTTP adapter.
Keep this page current when the entry points or runtime change.

- `src/routes/api.$.ts` mounts `src/server/api.ts` without starting another server.
- Services live in `@launchpad-kit/services`, outside HTTP and UI frameworks.
- `src/styles.css` installs Skeleton 5, Tailwind 4, and the Cerberus theme.
- `Dockerfile` (built from the repository root with `-f apps/controller/Dockerfile`) produces a non-root Bun runtime from Nitro's build output, with the operator commands (`bun .output/admin.mjs ...`).
- `src/server/runtime.ts` composes configuration, the shared Kysely database,
  Better Auth and the API on first use.
- `src/admin/main.ts` is the operator command, run through Omni (see First run). Omni
  loads `apps/controller/.env.local` (copy `.env.local.example`) into `dev` and `admin`.

## Configuration

| Variable                          | Meaning                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                    | PostgreSQL connection string (required)                                                                                                                                                                                                                                                                                                                                   |
| `LAUNCHPAD_AUTH_SECRET`           | Random secret, at least 32 characters (required)                                                                                                                                                                                                                                                                                                                          |
| `LAUNCHPAD_BASE_URL`              | Public controller URL; its origin is the only trusted origin (required)                                                                                                                                                                                                                                                                                                   |
| `LAUNCHPAD_ENROLLMENT`            | `operator` (default) or `invitation` (requires SMTP)                                                                                                                                                                                                                                                                                                                      |
| `LAUNCHPAD_PUBLIC_SIGNUP`         | `false` by default; sign-up is a separate policy from SMTP                                                                                                                                                                                                                                                                                                                |
| `LAUNCHPAD_SMTP_URL`              | Optional; set with `LAUNCHPAD_EMAIL_FROM` to enable email recovery and invitations. `smtps://` or `smtp://` (STARTTLS required unless loopback); no query options                                                                                                                                                                                                         |
| `HOST` / `PORT`                   | Listen address and port of the built server (default `127.0.0.1`-style host, port `3000`)                                                                                                                                                                                                                                                                                 |
| `LAUNCHPAD_DATA_DIR`              | Directory shared with the worker, readable and writable by **one user** (the controller's and the worker's alike: the worker builds in `build/` and collects and restores archives); uploaded archives are staged in `tmp/` and kept under `artifacts/` (default `.data/controller`). Mount durable storage here in production                                            |
| `LAUNCHPAD_DEPLOYMENTS`           | `off` (default) or `on`. `on` accepts app, project upload and deployment requests (they only queue work until a worker runs) and needs `LAUNCHPAD_APPS_DOMAIN` and an https `LAUNCHPAD_BASE_URL`. Limits: `LAUNCHPAD_MAX_APPS` (10), `LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP` (20), `LAUNCHPAD_MAX_DEPLOYMENTS` (100), `LAUNCHPAD_DEFAULT_TTL` (7d), `LAUNCHPAD_MAX_TTL` (30d) |
| `LAUNCHPAD_MAX_UPLOAD_BYTES` etc. | Archive limits: upload size, expanded size, entries, depth, timeout, stored artifacts, concurrent uploads (`LAUNCHPAD_MAX_*`, `LAUNCHPAD_UPLOAD_TIMEOUT_SECONDS`)                                                                                                                                                                                                         |
| `LAUNCHPAD_API_DOCS`              | `true` (default) serves the OpenAPI document and Scalar reference; `false` removes them                                                                                                                                                                                                                                                                                   |
| `LAUNCHPAD_TRUSTED_PROXY`         | `false` (default): the TCP peer address is the client address. `true`: exactly one trusted proxy that appends to `X-Forwarded-For`; its rightmost entry is used. Never set `true` without such a proxy                                                                                                                                                                    |

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

### Paging lists

Every list route under `/api/v1` (organizations, members, invitations, API keys, projects,
apps, aliases, deployments and alias operations) is opt-in paged. Without `limit` the
response is the whole bare array, exactly as before. With `limit` (1 to 100; there is no
default) it is at most that many items in the same order, and when more exist a
`Link: </api/v1/...?limit=N&cursor=...>; rel="next"` header. The reference is relative:
resolve it against the request URL and follow it as given. The `cursor` is opaque; do not
parse or build it. A cursor is bound to its list, parent and organization and is refused
with `422` elsewhere, as are a `limit` outside 1 to 100, a repeated `limit`, and a `cursor`
without a `limit`. A cursor never widens what a key may list: the organization, parent and
project allow-list always come from the authenticated request. The deployment events
route keeps `after` and `limit` (1 to 500, default 100) and adds a `Link` with
`after=<last seq>&limit=<n>` when `limit` is given and more events exist.

For key routes, access to the organization is checked first (`404` for another
organization). A malformed `limit` or `cursor` is then a `422` even for a parent (app or
alias) the key cannot see, and on the session-only lists (invitations, API keys) it is a
`422` before the membership check, because the query is validated first, as the events route
always did. The message is generic and names nothing.

The controller has no CORS plugin, so a browser sees `Link` on same-origin calls. If CORS is
ever added it must expose `Link` (`Access-Control-Expose-Headers: Link`). Query parameters
are declared to the OpenAPI plugin as a route `query` schema (`pageQuery`, `eventsQuery` in
`src/server/openapi.ts`) because the plugin replaces a route's `detail.parameters` with the
parameters it derives from the route; those schemas accept any value, and the services
return the API's own `422`.

To document a new route, add an entry to `docs` in `src/server/openapi.ts` and pass it as
the route's `detail`. In Elysia 2 RC the hook goes **before** the handler:
`.get(path, { detail: docs.x }, handler)`; the legacy handler-first order throws.

## First run

Copy `.env.local.example` to `.env.local` here and edit it; Omni loads it for `dev` and
`admin`. Take a `pg_dump` before every migrate: migrations are forward-only, so rolling
back means stopping the controller and restoring the dump. Stopping management access
never touches Dokku workloads.

A worker with deployments off opens no database (an enabled worker does not check the schema: start it only after `migrate --status` reports `pending: 0`); the controller checks the schema on its first request, and repeats a failed check every few
seconds, so it recovers by itself once the database is migrated (or reachable). A database that
is **behind** (the API answers `503 schema-mismatch`) needs `migrate`, and one
a **newer** version already migrated needs that version or a restored backup. `migrate --status`
lists applied and pending migrations and changes nothing (exit code 1 if any are pending or
unknown). The controller carries its migrations, bundled so they run without the repository:
`.output/migrations` for the controller (and the operator commands in `.output/admin.mjs`, so
`bun .output/admin.mjs migrate` works in the image). The worker has no migration bundle.
`LAUNCHPAD_MIGRATIONS_DIR` names another folder.
The existing `LAUNCHPAD_DATA_DIR` directory must be mounted/available before startup;
the controller does not create a missing mount.
This is a directory check, not proof of volume identity: an unintended anonymous `/data`
volume also passes. Verify that every writer/admin uses the intended shared storage.

Operator commands run as an Omni task whose command and options are named arguments.
Passwords come from a file only you can read (mode 600) or from piped stdin, never from
an argument or the environment. Omni does not forward piped stdin, so use a file:

```sh
omni -i run admin -p @launchpad-kit/controller -a command=migrate           # forward-only, explicit
omni -i run admin -p @launchpad-kit/controller -a command=migrate -a options=--status  # read-only
omni -i run admin -p @launchpad-kit/controller -a command=setup \
  -a "options=--email you@example.com --password-file /run/secrets/launchpad-operator"
omni -i run dev -p @launchpad-kit/controller                                 # dev server
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
`revoke-all-credentials --i-understand-this-signs-everyone-out` is the offline counterpart after
a [restore](../../docs/restore.md): in one transaction it deletes every session and emailed
token, revokes every API key and every open invitation, and writes an audit event with the counts.
It changes no password and needs no authentication settings. It is required after every restore (it is the only way to end emailed tokens for every user) and must run with the controller stopped:
anything issued while it runs is not revoked.
The controller never migrates on startup. There is no default password.
Provision people and organizations offline:

```sh
omni -i run admin -p @launchpad-kit/controller -a command=create-user \
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

For operators, use the task-oriented [backup](../../docs/backup.md),
[restore](../../docs/restore.md), [upgrade](../../docs/upgrade.md) and
[installation](../../docs/install.md) guides. The details below are the
command and behavior reference.

## Backup

```sh
omni -i run admin -p @launchpad-kit/controller -a command=backup -a options=/var/backups/launchpad/2026-11-18
omni -i run admin -p @launchpad-kit/controller -a command=verify-backup -a options=/var/backups/launchpad/2026-11-18
```

`backup` needs `DATABASE_URL`, the same `LAUNCHPAD_DATA_DIR` as the controller and the
PostgreSQL client tool `pg_dump` (version at least the server's; name another program with
`LAUNCHPAD_PG_DUMP`). It writes a **new** directory (it never overwrites one, and a run that fails
removes what it wrote; one that is killed can leave a partial directory, which has no
`manifest.json` and never verifies) holding `database.dump` (custom format), exactly the stored
archives the dump's live artifact rows refer to, and `manifest.json` with sizes and SHA-256
checksums. A database whose migrations are still pending can be backed up (do that before
`migrate`); an incompatible migration history is refused.

- **One consistent view.** The live artifact rows, the list of applied migrations and the dump
  are read in the same exported snapshot, and the files are copied for exactly those rows; an upload
  made meanwhile is just not in this backup. If a live row's file is missing or altered, the backup
  fails rather than record a restore that cannot work.
- **Quiesce deployment writes** before taking a matched backup used for rollback.
- **Keep the directory private** (it is created mode 0700). The dump holds password and API-key
  hashes **and live session tokens**: with the authentication secret they would let someone sign
  cookies, so never store the secret beside the backup. Environment files, the secret and
  Dokku's own state are **not** included; back those up separately.
- `verify-backup` re-checks every file against the manifest and reports anything missing,
  changed, extra or not a plain file; it needs no database.

## Restore

Restoring is a procedure, not one command. The current step-by-step
[restore how-to](../../docs/restore.md) includes the safety and recovery checks:

1. **Stop every worker, the controller and every admin job that can write** (the controller keeps its database connections and only checks the schema when it starts,
   so restart it after the restore), wait until each has exited, and then wait longer than the
   longest Dokku command and the deletion lease (five minutes by default). A worker's exit does not
   prove a Dokku destroy it started has finished, and a missing app is not proof either.
   Follow [the restore prerequisites](../../docs/restore.md) for worker settlement checks.
2. `restore <dir> --i-have-stopped-the-workers` into an **empty** database, or
   `--replace <host:port/database>` to replace one that has data, typing the address exactly as the
   refusal message prints it (naming only the database would not tell a scratch copy from the live
   one). Back the database up first.
    - It checks the backup against its manifest, and that `pg_restore` can read the dump, before it
      changes anything; it refuses a backup that holds migrations this version does not know.
    - It never overwrites a stored archive that has other content, and it never touches Dokku. The
      archives are copied first (each is checked against its checksum as it is copied) and the
      database second.
    - Replacing moves the old `public` schema aside, restores into a new one, checks that the
      result holds exactly the migrations and live archives the backup records, and only then drops
      the old schema. If the restore fails or does not check out, the old data is put back, except
      when the importer's exit cannot be verified (including after cancellation): then no rollback
      is attempted and the import record stays. Keep ingress closed, preserve the saved
      `launchpad_replaced_*` schema and follow the
      [crashed-import recovery](../../docs/restore.md#recover-a-crashed-importer-before-retrying).
      Everything in the `public` schema is replaced; other schemas are not touched. A backup is
      taken of `public` only, and a dump that would create another schema or an extension is refused;
      so is a replace while views, foreign keys or column defaults in other schemas depend on
      objects in `public` (other kinds of cross-schema dependency are not detected: keep
      Launchpad's database to itself).
    - Run it as the database role the controller and worker use, and that role must own the
      database: `--no-owner` makes the restoring role the owner of everything it creates, and the new
      `public` schema has only the default grants.
    - A backup with the v1 baseline and only known migrations can be restored.
      If the restore reports pending migrations, run `migrate` afterwards.
3. `check-restore` (read-only): lists live archives whose file is missing and non-deleted immutable
   deployments beyond queued whose Dokku app is gone (it asks Dokku with `apps:exists` over
   `DOKKU_SSH_*` settings, or
   pass `--no-dokku` to skip that; an unreachable Dokku is an error, not "missing"), and deployments
   whose deployment preview deadline has passed. It exits 1 if an archive or an app is missing.
4. Follow the [restore guide](../../docs/restore.md) for restricted maintenance startup,
   credential reconciliation and `recovery-clear`. Model mutations remain blocked by an
   fsynced external marker even if the restored dump said `ready`. Clearing always
   requires `recovery-clear --i-have-checked-the-dokku-host` after the 25-minute stop
   grace, plus verified database, archive, Dokku and applicable router evidence.
   Never remove these files manually.
   A crashed import also retains `deployment-import-in-progress`; another restore and clear
   refuse until the exact importer/wrappers and database backend have exited and an explicit
   `recovery-ack-import --i-have-stopped-the-importer` is durably audited. Custom PostgreSQL
   wrappers must forward `PGAPPNAME` to the actual client. This acknowledgement does not clear
   model recovery; see [crashed-import recovery](../../docs/restore.md#recover-a-crashed-importer-before-retrying).

```sh
omni -i run admin -p @launchpad-kit/controller -a command=restore \
  -a "options=/var/backups/launchpad/2026-11-18 --i-have-stopped-the-workers"
omni -i run admin -p @launchpad-kit/controller -a command=check-restore
```

`restore` runs `pg_restore` (override with `LAUNCHPAD_PG_RESTORE`; its version must be at least
the `pg_dump`'s that wrote the backup) with the dump on its standard input and the connection
settings in `PG*` variables. The environment files, the authentication secret and Dokku's own state
are not in a backup: put them back yourself. Archives the data directory holds that the backup
does not are left alone. The worker does not collect them; do not rely on automatic cleanup
in this release. A restore killed halfway can leave `*.restore-*` temporary files beside the archives
(delete them).
If it was killed after the old schema was moved aside, the database may have an empty, partly
restored or missing `public` schema, with the old data in a `launchpad_replaced_*` schema: list
them with `select nspname from pg_namespace where nspname like 'launchpad_replaced_%'`, then either
restore the pre-restore backup, or put the old data back, whatever state `public` is in, with
`drop schema if exists public cascade; alter schema launchpad_replaced_<timestamp> rename to public;`
(what was restored into `public` had not been checked yet). First confirm no `pg_restore` is
still running (a killed `restore` does not stop it, and it could commit after your recovery) and
that nothing else is connected: `select pid, application_name from pg_stat_activity where
datname = current_database() and pid <> pg_backend_pid();`. Do this before the controller or any
worker starts.

## API keys

Owners and admins manage keys on the organization page. Choose explicit scopes,
expiry (at most 365 days) and optional project restrictions. The default is
organization/project read access. `member:read` includes all members' email
addresses; the UI does not offer the reserved `project:delete` scope.
Key lists retain historical scope names so keys issued before the cutover remain inspectable and
revocable. This is metadata only: new keys cannot request retired scopes, and a bearer key with
any unknown scope is refused entirely.

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
was given (`organization:read`, `member:read`, `project:read`, `project:create`, the reserved `project:delete`, and `app:read`, `app:deploy`, `app:delete`, `app:promote`, `app:alias:manage`), optionally to named projects, and never exceeds
its creator's current role; it stops working when it expires, is revoked, or its creator
leaves the organization. Keys cannot manage keys, members, invitations or organizations.

Project-restricted keys cannot be issued with `project:create`. Both email and
operator password recovery revoke the user's API keys; removing a member also
deactivates and audits their active keys. Recovery audit events count revoked keys.
The emailed-reset callback runs after Better Auth commits its password change.
If the callback fails, the response reports failure but the password/token change
may already have committed. Key revocation precedes its audit insert, so audit
failure does not restore keys. Use operator recovery if necessary.

## Instance status

`GET /api/v1/status` is for the instance operator and needs a session (an API key cannot read it,
whatever its scopes; an organization owner who is not the operator gets 403). It returns counts only:
`dependencies.database` (`ok` if the request got an answer), `artifacts` (count and bytes from
uncollected database rows, not checks that archive files exist) and `warnings` (always empty in this
version). Workers, queues and deployments report nothing here yet. There is no dashboard panel for it.

## Apps, uploads and deployments

With `LAUNCHPAD_DEPLOYMENTS=on`, under `/api/v1/organizations/{orgId}`: `POST /projects/{projectId}/artifacts` (the
archive as `application/gzip` with a `Content-Length`), `POST /projects/{projectId}/apps`, `GET /apps`, `GET /apps/{appId}`,
`POST /apps/{appId}/deployments` (202, queued), `GET /apps/{appId}/deployments`, `GET /deployments/{deploymentId}` and
`/events`, and `DELETE /deployments/{deploymentId}` (202). Keys need `app:read`, `app:deploy`, `app:delete`, `app:promote` or `app:alias:manage`; a
project-limited key reaches only its projects and may deploy only archives uploaded through the app's project.
While off, writes answer 503 and reads still work. A queued deployment waits for an enabled worker. Only a finished
deployment can be deleted: a worker destroys its own Dokku app and local image, and its hostname and name stay
reserved permanently. With `LAUNCHPAD_ALIASES=on` (needs deployments on), `POST /apps/{appId}/aliases`, `GET /apps/{appId}/aliases` and `GET /aliases/{aliasId}` create and read aliases: a permanent hostname per alias, created unbound (it routes nowhere yet; the router's fixed 404 comes later). `POST /aliases/{aliasId}/promotions` (`app:promote`, `Idempotency-Key` required, 202), `DELETE /aliases/{aliasId}` (withdraw; `app:alias:manage`, key and `expectedGeneration` body, 202) and `GET /aliases/{aliasId}/operations` point an alias at a succeeded deployment, withdraw it and follow the worker; `DELETE /apps/{appId}` is the explicit, resumable app shutdown (admins; a key needs `app:delete`, `app:alias:manage` and `app:promote`). Limits: `LAUNCHPAD_MAX_ALIASES_PER_APP` (5) and `LAUNCHPAD_MAX_ALIASES` (50). See [deployments](../../docs/deployments.md) for a worked example. Each operation is in the OpenAPI document.

A deployment the worker could not confirm is `reconciliation-needed` and blocks its app. After
checking Dokku by exact name, record what you saw with
`bun .output/admin.mjs deployment-reconcile --deployment <id> --outcome failed-clean --i-have-verified-dokku-by-exact-name`.
The outcome is one of `succeeded`, `failed-clean`, `failed-owned` or `abandon`.
It never calls Dokku and is audited; `succeeded` needs a recorded image. Use `failed-owned` when a held app
creation actually left its app on Dokku, so a later deletion can destroy it; after `failed-clean` or `abandon`
deletion never destroys a name that was not recorded as created. For a deletion, only `succeeded` (the app is
gone) and `failed-clean` (it was not destroyed) are allowed. A held deletion does not block the app, but it keeps
counting toward quota and shows only as `desiredState` `deleting`; look at the deployment's events for
`deletion-reconciliation-needed`.

## Apps, deployments and aliases

In an organization, use **Apps and deployments** to upload an archive, deploy it to its own URL,
and separately promote a succeeded deployment to a chosen stable alias. Admins and owners with
a fresh session can request operator review of held work; only instance operators can verify
evidence and reconcile it. The API key form offers separate app read, deploy, promote,
alias-management and deletion scopes.

Uploads are project-scoped under `app:deploy`; see [deployments](../../docs/deployments.md).
