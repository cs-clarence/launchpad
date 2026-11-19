# Replacement schema map (migration 018)

Status: **revised 2026-11-19: replace, do not retire.** For the author and reviewer of
migration `20261119_018_immutable_deployment_model`. This is the contract for its SQL;
it is not the SQL. See the [P2 plan](../plans/immutable-p2-cutover.md), the
[parent plan](../plans/immutable-deployment-model.md) and the
[resource and state-machine design](deployment-modes.md).

The earlier draft of this document specified retiring the preview tables into
read-only `legacy_*` history with reserved identities, a refusal guard, an object-name
inventory and an old-process drill. The user chose to drop the legacy runtime and its
data unconditionally (nothing is in production), so all of that is removed. The P1
test-only SQL and drill on `main` specify the retired design and are deleted by P2.

## What the migration does

Inside the migrator's own transaction (Kysely takes the advisory lock and runs all
pending migrations in one transaction; 018 opens no transaction of its own):

1. `SET LOCAL lock_timeout`, so a straggling session fails the migration instead of
   queueing an exclusive lock behind every reader.
2. Drop `deployment_event`, `deletion_operation`, `deployment`, `preview` and
   `worker_heartbeat` **and their data, unconditionally**, with one
   `DROP TABLE a, b, c, d, e` statement and no `CASCADE`. The four preview tables
   reference each other in a cycle (`preview.active_deployment_id` references `deployment`), so
   they must go in one statement, and omitting `CASCADE` makes the migration fail if anything
   unexpected depends on them. Nothing writes heartbeats after P2a; P3 designs its own. No refusal, no history, no reservation of
   the dropped hostnames or Dokku names. It does not touch Dokku: apps those previews
   owned stay on the host until the operator removes them by exact name.
3. Delete all `idempotency_key` rows (temporary replay records; the table is kept and
   emptied on purpose), delete the `instance_state` key `lifecycle.enabled_at`, and revoke
   every API key with a scope that starts with `preview:`, including keys that also hold
   other scopes (legacy automation keys are not grandfathered), recording counts only in
   the audit event.
4. Create the tables below, their guards, and initialize the recovery gate.

A failure in any step rolls everything back. The new tables do not reuse the dropped
names, so an old process that survives fails with "relation does not exist" instead of
operating on new rows; its startup check refuses once 018 is recorded. That does not stop a
process already running or a Dokku operation it already dispatched, so the runbook is to stop
every old controller, worker and admin job, and let in-flight remote work settle, first.

## Physical table map

All timestamps are `timestamptz`; IDs are UUID except the existing organization and
user IDs (`text`). Every resource has an organization-qualified unique key for use in
foreign keys, and all references are `ON DELETE RESTRICT`, never cascade. Actor
references point to the existing user table.

Explicit composite keys and FK targets:

- `app`: `UNIQUE(organization_id,id)` and `UNIQUE(organization_id,project_id,id)`; its
  project FK is `(organization_id,project_id) → project(organization_id,id)`.
- `app_alias`: `UNIQUE(organization_id,app_id,id)`; the promotion alias FK references
  that exact triple.
- `immutable_deployment`: `UNIQUE(organization_id,id)` and
  `UNIQUE(organization_id,app_id,id)`; deletion's FK uses
  `(organization_id,app_id,deployment_id)`, as do alias and promotion targets.
- `promotion_operation`: `UNIQUE(alias_id,id)` supports nullable
  `(alias_id,supersedes_operation_id)` and `(alias_id,superseded_by_operation_id)`
  self-FKs. Same-alias membership implies same app and organization. Reciprocal and
  acyclic supersession remain service checks.

| Table                           | Required fields / constraints                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`                           | `id`, `organization_id`, `project_id`, `slug`, `state` (`active`, `shutting-down`, `deleted`), actor/timestamps; qualified project FK, unique `(organization_id,id)`, partial live `(project_id,slug)` uniqueness                                                                                                                                                                                                         |
| `immutable_deployment`          | `id`, org/app/artifact, fixed `spa`, permanent `app_name`/`hostname`, job status, `attempt`, lease owner/expiry, done/pending step, image tag and image ID, fixed failure fields, requester/timestamps, required `preview_expires_at`, nullable `last_unpinned_at`, deletion state/timestamp; qualified app/artifact FKs; unique `(organization_id,app_id,id)`; no preview ID, active-deployment pointer or rollback step |
| `app_deployment_event`          | identity bigint PK, org/deployment, positive `seq`, phase, level, bounded fixed message, timestamp; FK `(organization_id,deployment_id)` to `immutable_deployment`; unique `(deployment_id,seq)`                                                                                                                                                                                                                          |
| `app_alias`                     | ID/org/app/slug, permanent hostname, state from design, nullable committed target, nonnegative bigint `reserved_generation` and `committed_generation`, actor/timestamps; committed ≤ reserved; target FK `(organization_id,app_id,target_deployment_id)`; live slug unique per app; positive generation on bound state                                                                                                   |
| `promotion_operation`           | ID/org/app/alias, action, previous/desired target, expected generation, allocated generation, status, attempt/fence/lease, done/pending intent, actor/idempotency/timestamps, safe outcome details, supersedes/superseded-by; bind requires desired target; withdraw requires null desired target; same-app/org alias and target FKs; unique `(alias_id,generation)`                                                      |
| `deployment_deletion_operation` | ID/org/app/deployment, reason (`manual`, `expired`, `shutdown`), status, attempt, independently monotonic fence, lease, done/pending destroy/images step, requester and timestamps; qualified deployment FK; unfinished unique per deployment                                                                                                                                                                             |
| `hostname_reservation`          | permanent hostname PK, kind/owner/org, created/released timestamps, owner uniqueness and deferred reciprocal triggers                                                                                                                                                                                                                                                                                                     |
| `dokku_name_reservation`        | permanent opaque app-name PK, kind/owner/org, created/released timestamps, owner uniqueness and deferred reciprocal triggers                                                                                                                                                                                                                                                                                              |

The unfinished-deployment index is on `app_id` for `queued`, `preparing`,
`building`, `deploying`, `verifying`, `reconciliation-needed`.
New terminal status never authorizes an in-place redeploy. Deletion has its own
state and does not rewrite a succeeded deployment's immutable identity/settings.
The unfinished promotion index covers unfinished operations only when
`superseded_by_operation_id IS NULL`; links are qualified to the same alias.
No clock-dependent SQL index predicate. Generation strings remain decimal in JS;
positive values are bounded by PostgreSQL bigint max and never recycled.

Eligibility/pins cannot be implemented by FKs alone. Allocation takes the org quota
lock before the app lock. Every pin reservation, finalization, correction and GC
decision takes app, ordered aliases, ordered deployments, then operation locks.
Operations reference previous/desired targets through the full unresolved chain.
These requirements become service/SQL integration tests, not merely this map.

## Permanent identity registries

`hostname_reservation` and `dokku_name_reservation` hold every hostname and Dokku app
name ever allocated. Owners are `deployment` or `alias` for hostnames and `deployment`
for Dokku names (an alias owns no Dokku app). `released_at` is an audit fact and never
frees a key.

- A row's owner must exist, in the same organization, with the same hostname or app name,
  and every owner must have its row. This is checked by `DEFERRABLE INITIALLY DEFERRED`
  constraint triggers on both sides, so it is validated on the final state at COMMIT and
  the order of inserts inside a transaction does not matter.
- Owner identity, registry identity, release history, app identity and operation intent
  cannot be rewritten; fences and generations only increase; completed deployments cannot
  change status or image; a deleted resource cannot be reactivated; rows cannot be
  deleted, and `BEFORE TRUNCATE` statement guards cover every table above.
- A release is accepted only for a soft-deleted deployment or a withdrawn alias.
- `immutable_deployment.app_name` keeps the `lp-[a-z0-9]{10}` namespace; hostnames are
  lowercase DNS names (`<= 253` characters, labels `<= 63`); image tags are unique.
- The validator functions are ordinary `plpgsql` with a fixed `search_path`. They are
  **not** `SECURITY DEFINER`: with no legacy tables there is nothing the application role
  cannot read, so there is no privilege to elevate.

**Residual (stated, not hidden):** these guards are owned by the schema owner, who is also
the application's role today. They defend against bugs and mistaken SQL, not against the
application's own database role, which can still `ALTER` or `DISABLE TRIGGER`. Splitting
owner and application roles is a deployment decision and belongs to the production Compose
plan, where it is also tested through backup and restore (`pg_dump --no-owner
--no-privileges` drops ownership and grants).

## Restore and the recovery gate

A restored database may disagree with the router and Dokku, so model mutations stay off until
that is reconciled. The rule keys on **this binary knowing 018**, never on the manifest: an
older dump restored over an installation that already ran the model would otherwise bring
back an empty registry and stale generations while the router and Dokku keep the old state.

- **Marker.** Every restore by a binary that knows 018 writes
  `<data dir>/maintenance/immutable-recovery-blocked`, owner-only, by atomic rename with the
  file and its directory fsynced. It lives outside the dump, so a restored `ready` row cannot
  clear it. It is written **after** every refusal and the archive pre-check, and **before** the
  first archive copy, so a refused restore blocks nothing. A restore that fails part-way keeps
  the marker on purpose: partial state is never offered to workers.
- **Database gate.** `instance_state` key `immutable_recovery`, `blocked` or `ready`. Migration
  018 initializes `ready`. After import, restore sets and verifies `blocked`.
- **Scope.** The gate covers **model mutations only**: apps, deployments, aliases, promotions,
  deletions, artifact collection and the worker. Sign-in, sessions, organizations, projects,
  members and API-key administration stay available, or a restored controller could not be used.
- **Checks.** A missing gate row is permitted only while 018 is not recorded in
  `launchpad_migration`; with 018 recorded and no row it is refused. An unreadable marker
  directory or database fails closed. The marker lives in the data directory the artifacts
  already require every process to share (one `LAUNCHPAD_DATA_DIR` volume); a missing mount is a
  startup error, never permission to assume readiness.
- **Clearing.** `launchpad-admin recovery-clear` sets `ready` under the recovery locks, then
  removes the marker and fsyncs the directory (a crash in between stays blocked). **Empty model
  tables prove nothing about remote state**: after an older dump is restored over an installation
  that already used the model, the tables are empty while the router and Dokku still hold the old
  routes and apps. The rule therefore has two parts, and the outcome is unambiguous:
    - **Writer-seen record.** The first model writer creates a durable file
      `<data dir>/maintenance/model-writer-seen`, outside the dump, so a restore cannot erase it.
      P2b has no writer, so on a P2b installation the file never exists.
    - **P2b rule.** `recovery-clear` **succeeds** only if every model table is empty **and** the
      writer-seen file does not exist; it **refuses** in every other case, including an empty
      database after any writer has run. Rolling back to a P2b binary after P3 has written is not
      supported, and this record is what makes the P2b command refuse if someone does.
    - **P3 replacement.** The P3 PR that adds the first writer must also replace the rule with
      verified router and Dokku reconciliation (P5) in the same PR, and a test must assert the
      empty-tables rule is gone. If that replacement is not ready, P3 cannot merge a writer.
- **Older dumps.** There is no backup floor. An older dump restores, is migrated forward, and
  018 drops its preview tables again; the marker is written like any restore.

## API scopes

`preview:*` scopes are removed from issuance and authentication and fail closed if a
stored key somehow survives; they are never mapped to `app:*`. The new `app:read`,
`app:deploy`, `app:promote`, `app:alias:manage` and `app:delete` scopes follow the
[permission matrix](deployment-modes.md#permission-matrix-and-client-confirmation).

## Verification (P2b)

`SET LOCAL lock_timeout` covers only 018; a run that starts from 014 is not protected for 015 to 017.

On disposable PostgreSQL, from the frozen schema-014 fixture and from an empty database:

- 017 then 018 in one migrator run, and 018 alone; a refusal (for example a held
  conflicting lock hitting `lock_timeout`) leaves the schema untouched.
- Preview data of every state is dropped, and the new tables are empty.
- Every reservation rule above, each by a failing case and a passing control, including
  COMMIT-time failures, cross-organization and cross-app keys, immutable fields, TRUNCATE
  and delete refusal, and cross-kind hostname races.
- Key revocation (mixed, unknown-prefix, case variant, already revoked) and count-only
  audit; idempotency rows removed; sessions untouched.
- An old binary against the migrated schema is refused at startup (018 recorded).
- Restore: a post-018 backup round trip writes the marker and sets the gate; a crash after
  import before the gate write stays blocked after a fresh start; an older dump restores,
  migrates, and writes the marker like any restore.
- The upgrade drill and the built images run the new migration, and the drill asserts the
  four preview tables and `worker_heartbeat` are gone afterwards.
- An old dump restored over a database that already holds model rows writes the marker.
- `recovery-clear` refuses while any model table has a row, and refuses on an empty database
  once the `model-writer-seen` file exists (simulated by creating it).
