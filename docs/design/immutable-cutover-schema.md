# Immutable cutover schema map

Status: **P1 draft; executable retirement and model/reservation segments**, 2026-11-19.
For the author and reviewer of migration
`20261119_018_immutable_deployment_model`. This specifies the retirement map and
new physical schema. Complete executable SQL and deferred-trigger implementation
must be reviewed before P2; this document does not authorize migration.
See the [delivery plan](../plans/immutable-deployment-model.md) and
[resource/state-machine design](deployment-modes.md).

The test-only [retirement SQL candidate](../../apps/controller/src/admin/__tests__/fixtures/immutable-retirement.sql)
now executes the locking/refusal/rename/key-revocation segment against isolated
PostgreSQL databases. It explicitly refuses non-`lp_test_` database names, is not
discoverable by `migrate`, and does not record migration 018. It installs no new
model tables, reservations/triggers, restricted-role grants, restore floor or
recovery gate. It is **not a standalone safe installation cutover**.
Those remaining segments must join the same transaction in P2.
The paired [model SQL candidate](../../apps/controller/src/admin/__tests__/fixtures/immutable-model.sql)
now creates the eight new tables, constraints, identity guards and reciprocal
reservation triggers in the same test transaction as retirement, retaining its
exclusive locks. All historical previews seed both registries before their tables
are frozen. Both candidates remain outside migration discovery and record no
migration 018. Functions are fixture-owned by the test migrator, not yet the
production non-login definer role; metadata checks are not restricted-role
execution proof.
The candidate's currently tested/supported PostgreSQL major is **17**, matching
the disposable `postgres:17-alpine` fixture. A suite assertion records that major.
Constraint-name comparison filters to PK/unique/FK/check/exclusion types so
PostgreSQL 18's extra NOT NULL catalog rows do not contaminate that name set;
this filter alone does **not** establish PostgreSQL 18 support.

## Immutable input and old-process fixtures

The historical source of truth is commit
`39fbc29cc1549763564eafb0612da5a211a6e924`, not the rebased branch's new hashes.
Preserve that object before building the P2 compatibility fixture. Build the old
artifact from that tree with its own lockfile; do not import current services
into an alleged old-worker test.

| Baseline source                        | SHA-256 of exact Git blob contents                                 |
| -------------------------------------- | ------------------------------------------------------------------ |
| `packages/services/src/deployments.ts` | `d130632341a6d1418bf028a3946c51a3d9ce9f913c0cb10a583d2e28387fed48` |
| `packages/services/src/deletions.ts`   | `850dfcb86d31d2fad5515f20b2ffecaa10131b83d893da68ffd2a9be2716ded7` |
| `packages/services/src/artifact-gc.ts` | `aeb8d63f47e41ddc12d208d5c8f6f2d9a35e3a315754222b2a22191a69214ffc` |

The compatibility test extracts the commit with `git archive` and re-links its
workspace packages to the extracted tree, but it uses the **current** third-party
dependencies, not the baseline's own lockfile, and runs source rather than a built
artifact. The three hashes cover only the three files above; `packages/database` is
trusted through the archive. A package resolves its own name through itself, so the
check that matters is that its _dependencies_ resolve inside the extracted tree; the
subprocess asserts that and a mutation check proves it can fail.

Hashes above were read from the historical Git objects, not copied from the
current working tree. P2 must preserve/build the full baseline artifact and
record its digest too; these three source hashes are provenance, not a substitute
for running its real entrypoints.

## Transaction and retirement map

Before invoking migration: close application ingress/writers, stop all old
controller/worker/admin/GC processes, settle remote operations and pending archive
moves, fence every old database login and terminate its sessions. A distinct
maintenance principal runs migration; new application processes never inherit the
old login. Stop if the operator cannot prove these prerequisites. Password
rotation alone does not disconnect existing sessions. Database fencing alone
does not revoke SSH, Docker or filesystem access from an old process.

Inside the forward-only migration transaction:

1. Take `ACCESS EXCLUSIVE` locks in this exact order:
   `"user"`, `organization`, `project`, `member`, `api_key`, `artifact`,
   `preview`, `deployment`, `deployment_event`, `deletion_operation`,
   `idempotency_key`, `worker_heartbeat`, `instance_state`, `audit_event`.
   Parent identities precede their dependents; allocation, heartbeats,
   revocation/auditing and old idempotency writers cannot race this transaction.
   Migration bookkeeping remains Kysely's responsibility. Other auth tables
   (sessions/accounts/verifications/login attempts/invitations) are neither
   rewritten nor referenced by new FKs; old writers are already fenced and
   this migration does not invalidate sessions.
   Do not make network or filesystem calls inside this transaction.
2. Refuse any preview not terminally deleted; any deployment outside
   `succeeded`, `failed`, `cancelled`; any deletion not `succeeded`; any
   non-null `step_pending`, `lease_owner` or `lease_expires_at` on **any**
   legacy deployment/deletion row, including terminal rows. Expiry is not proof
   of settling. Preview/event tables have no lease or pending-step columns.
   Do not clear intent or invent a successful remote outcome.
3. Rename the four legacy tables and their owned objects as below.
4. Create the new schema, seed permanent identity reservations, revoke legacy
   grants with audit counts, and initialize the recovery gate.
5. Verify reservation set equality and reciprocal ownership before commit.
   Any failure rolls back all DDL, seeding, revocation and audit writes.

| Current table        | Retired table               | Dependent objects and preserved data                                                                                                                      |
| -------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preview`            | `legacy_preview`            | PK, org/project FKs, `(organization_id,id)`, permanent `app_name`/`hostname` uniqueness, live slug index, active-deployment FK, expiry/deleted timestamps |
| `deployment`         | `legacy_deployment`         | PK, org/artifact/preview FKs, `(organization_id,preview_id,id)`, unfinished index, claim index, image identity, lease/step/rollback history               |
| `deployment_event`   | `legacy_deployment_event`   | PK, identity sequence ownership, deployment FK, unique `(deployment_id,seq)`                                                                              |
| `deletion_operation` | `legacy_deletion_operation` | PK, preview/org/user FKs, claim/unfinished indexes, attempt and monotonic fence                                                                           |

PostgreSQL renames table references in existing FKs but not every object name.
P2 explicitly enumerates constraint/index/identity-sequence names from the frozen
schema and assigns `legacy_` names, including schema-level backing indexes.
No `deployment`, `deployment_event`, `deletion_operation` or `preview` views or
tables remain. Do not drop history or rebuild it through a lossy projection.
Keep existing referential restrictions; application credentials cannot mutate
legacy history. Maintenance/forensic access is separate.

`artifact`, `idempotency_key`, `worker_heartbeat`, `instance_state`, auth,
organizations, projects and audit tables remain. Existing idempotency entries
remain under old endpoint names; new endpoints cannot replay them as new grants.
Worker heartbeats remain historical and never prove old processes are fenced.

### Existing object names

These names follow migrations 010–016, including PostgreSQL's names for unnamed
constraints. The executable candidate compares real schema-017 owned constraint/
index names and the event identity-sequence mapping with this list; the schema-017 positive
case passes on disposable PostgreSQL. P2 must repeat against the frozen fixture;
unexpected names within the inspected sets cause refusal. This is not a full
dependency inventory: incoming FKs, views, rules, RLS policies, publications,
dependent functions, extra columns/defaults, ownership/grants and index ownership
are not checked. Neither are constraint definitions, validation state or
deferrability. P2's dependency/grant review must cover these before deployment;
names alone cannot prove arbitrary out-of-band schema changes safe.
Constraints are table-scoped, so their
renaming is cosmetic. Indexes (including constraint-backed indexes) and sequences
share the schema namespace. This map renames every listed owned object to its
`legacy_` equivalent for clarity, not because every rename is required to avoid
a clash with the distinctly named new tables.

| Owner                | Existing indexes (constraint-backed included)                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preview`            | `preview_pkey`, `preview_app_name_key`, `preview_hostname_key`, `preview_organization_id_id_key`, `preview_project_slug_live_idx`, `preview_expiry_idx`                                           |
| `deployment`         | `deployment_pkey`, `deployment_organization_id_id_key`, `deployment_organization_id_preview_id_id_key`, `deployment_one_unfinished_per_preview`, `deployment_preview_idx`, `deployment_claim_idx` |
| `deployment_event`   | `deployment_event_pkey`, `deployment_event_deployment_id_seq_key`                                                                                                                                 |
| `deletion_operation` | `deletion_operation_pkey`, `deletion_operation_organization_id_id_key`, `deletion_one_unfinished_per_preview`, `deletion_claim_idx`                                                               |

Rename PK/unique constraints with `ALTER TABLE ... RENAME CONSTRAINT`, which
also renames their backing indexes; do not rename those indexes twice.
Standalone indexes use `ALTER INDEX ... RENAME TO ...`.
`preview_project_id_slug_key` was dropped by migration 016; never recreate it.

| Owner                | Existing FK/check constraint names                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `preview`            | `preview_organization_id_fkey`, `preview_created_by_fkey`, `preview_organization_id_project_id_fkey`, `preview_organization_id_id_active_deployment_id_fkey`, `preview_slug_check`, `preview_app_name_check`, `preview_hostname_check`, `preview_desired_state_check`, `preview_deleted_at_matches_state`                                                          |
| `deployment`         | `deployment_organization_id_fkey`, `deployment_requested_by_fkey`, `deployment_organization_id_preview_id_fkey`, `deployment_organization_id_artifact_id_fkey`, `deployment_status_check`, `deployment_attempt_check`, `deployment_step_done_check`, `deployment_step_pending_check`                                                                               |
| `deployment_event`   | `deployment_event_organization_id_fkey`, `deployment_event_organization_id_deployment_id_fkey`, `deployment_event_seq_check`, `deployment_event_level_check`, `deployment_event_message_check`                                                                                                                                                                     |
| `deletion_operation` | `deletion_operation_organization_id_fkey`, `deletion_operation_requested_by_fkey`, `deletion_operation_organization_id_preview_id_fkey`, `deletion_operation_reason_check`, `deletion_operation_status_check`, `deletion_operation_attempt_check`, `deletion_operation_fence_check`, `deletion_operation_step_done_check`, `deletion_operation_step_pending_check` |

The only identity sequence is `deployment_event_id_seq`; rename it to
`legacy_deployment_event_id_seq`, preserving generation, current sequence value
and ownership of the renamed event column. There are no existing user triggers
or trigger functions to rename; reciprocal reservation triggers are new work.

## Permanent identity reservation sources

No source query filters by live state or slug. Slug reuse is irrelevant to
identity ownership: every historical preview ID retains its own reservations.
Refuse legacy hostnames that are not already lowercase canonical DNS names, or
whose lowercase values collide. Never silently lowercase, trim or reassign a
recorded hostname. Malformed historical identity requires separately reviewed
operator action; migration does not edit it to make seeding pass.

| Registry                 | Seed query source               | Identity                                                 |
| ------------------------ | ------------------------------- | -------------------------------------------------------- |
| `hostname_reservation`   | every `legacy_preview.hostname` | `legacy_preview.id`, organization, kind `legacy_preview` |
| `dokku_name_reservation` | every `legacy_preview.app_name` | same owner ID/organization/kind                          |

The baseline has no distinct hostname/app-name columns on deployments, deletion
operations or events. A rollback refers to a deployment of the same preview and
therefore the same recorded remote app. Verify those FKs during seeding; never
parse image tags or event prose to infer an additional owned remote resource.
If later inspection discovers another identity source, stop and extend this map.

New deployment and alias allocation inserts registry and owner atomically.
Hostnames are lowercase DNS names; registry PK is the canonical hostname, and
`UNIQUE(owner_kind,owner_id)` prevents a second reservation for one owner.
Dokku names have their own permanent PK and the same owner uniqueness.
No cascade from organization/project deletion may remove these records.
`released_at` is an audit timestamp, never availability for reuse.
The runtime soft-deletes owning resources; hard deletion is not an application API.
Release auditing requires a deleted deployment/legacy preview or withdrawn alias,
checked against the final owner state at COMMIT. Release still never frees a key.

Each registry has a `DEFERRABLE INITIALLY DEFERRED` constraint trigger for
inserts/updates, and reciprocal triggers on its owner tables. Row deletion is
rejected immediately by permanent-history guards, before a deferred DELETE
event could be needed. Statement-level BEFORE TRUNCATE guards additionally cover
all twelve model/registry/legacy tables, including cascading truncation. New
deployment events are append-only. At commit,
an owner must exist with matching organization and exact name/hostname, and each
owner must have its one registry row. Validate the final state, not a transient
intermediate statement. PK/unique conflicts serialize concurrent allocation.
Reject owner-kind/owner-ID changes after admission. For Dokku names, allowed
owners are `legacy_preview` and `deployment`; aliases own no Dokku app.
For hostname reservations, allowed owners are `legacy_preview`, `deployment`
and `alias`.
New `immutable_deployment.app_name` has the same
`CHECK (app_name ~ '^lp-[a-z0-9]{10}$')` as legacy previews.
The retirement candidate also validates every legacy `app_name` directly under
the table locks, independently of the constraint-name check. Its refusal
fixtures deliberately weaken the named legacy check to prove malformed names
cannot enter the later Dokku-name registry merely because a check has that name.

Commit-time validation reads frozen owners through narrowly scoped
`SECURITY DEFINER` trigger functions, owned by a maintenance-managed non-login
role with only the required owner/registry read privileges. Functions use fixed
`search_path = pg_catalog`, fully qualified `public.*` relations, no dynamic SQL
and no caller-selected relation/function names. Revoke public direct execution
and schema-creation privileges. Review function ownership/grants with the SQL;
test under restricted application credentials, not only the schema owner.
P2 must also revoke TRUNCATE and prevent application roles from owning tables,
disabling triggers, changing `session_replication_role`, or inheriting those
powers. An owner/superuser can deliberately bypass triggers; the fixture does
not claim protection against that privileged operator.

## New physical table map

All timestamps are `timestamptz`, IDs are UUID except existing organization/user
IDs (`text`). All resource PKs also have organization-qualified unique keys for
FKs. Use `ON DELETE RESTRICT` for resources/history/ownership, not cascade.
Required actor references point to the existing user table.

Explicit composite keys and FK targets:

- `app`: `UNIQUE(organization_id,id)` and
  `UNIQUE(organization_id,project_id,id)`; its project FK is
  `(organization_id,project_id) → project(organization_id,id)`.
- `app_alias`: `UNIQUE(organization_id,app_id,id)`; the promotion alias FK
  references that exact triple.
- `immutable_deployment`: `UNIQUE(organization_id,id)` and
  `UNIQUE(organization_id,app_id,id)`; deletion's FK uses
  `(organization_id,app_id,deployment_id)`, as do alias and promotion targets.
- `promotion_operation`: `UNIQUE(alias_id,id)` supports nullable
  `(alias_id,supersedes_operation_id)` and
  `(alias_id,superseded_by_operation_id)` self-FKs. Same-alias membership implies
  same app/org. Service locking also enforces reciprocal, acyclic supersession.

The model candidate additionally freezes app/project identity, owner identity,
deployment artifact/SPA settings, completed deployment images/status, and
promotion/deletion intent. Fences and alias generations cannot decrease.
New queues use integer retry `attempt` fields and independent nonnegative bigint
fences; SQL updates cannot lower the fences. A future retry-budget reset must
never reset its independent fence.
Non-null image tags are unique among immutable deployment owners, so new-model
cleanup cannot treat a shared tag as belonging to two deployments. Build-time
image identity/probe verification and legacy-image ownership remain P3 gates.
These guards do **not** replace the worker's fenced WHERE clauses, authorization,
pin/reservation locks, target eligibility, app-shutdown or quota checks. Those
service/worker gates are still unimplemented. Supersession self-FKs establish
same-alias membership only; reciprocal/acyclic higher-generation chains remain
service checks, not a claim of this candidate.
Settled succeeded/failed promotions cannot acquire a corrective successor, and
`superseded` status requires a successor. The reverse is deliberately not a
CHECK: linked uncertain predecessors remain unfinished until the corrective
barrier is verified, preserving their pins. The normally unreachable
`legacy_preview_reservations` owner trigger is not seed-coverage evidence;
registry INSERT events validate the frozen legacy seeds.
Manual deployment deletion requires an actor. Deployment deletion cannot be
cancelled by changing `deleting` back to `active`.
A further ten cases run the model under **test-only** roles: a NOLOGIN definer
that owns the three SECURITY DEFINER validators, and an application role that
owns nothing. The deferred owner checks succeed for that role although it cannot
read `legacy_preview`, a missing reservation still fails at COMMIT, and the role
cannot truncate or delete registry history, disable triggers, set
`session_replication_role`, drop or re-own a guard function, or execute a
validator directly. This shows the design works when the roles are separated; it
is **not** the production role setup. P2 must still create the real roles and
grants, record them in the migration, and repeat these cases against them.
The model/reservation suite currently passes 67 cases on PostgreSQL 17,
including deferred COMMIT failures, reservation-before-owner ordering,
cross-kind allocation blocked by an uncommitted competing reservation,
cross-org/app FK failures, permanent released names and atomic rollback of
retirement plus model creation. It checks hardened function metadata, **not**
execution under the intended restricted production role.

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

## Restore and scope boundary

Use `instance_state.key='immutable_recovery'`, value `blocked` or `ready`.
Fresh/retired migration initializes `ready` only after all retirement checks pass.
Before any import/archive mutation, restore writes an owner-only durable marker
`<LAUNCHPAD_DATA_DIR>/maintenance/immutable-recovery-blocked`, outside the dump
and backup archive subtree, using atomic rename and file/directory fsync.
All new mutating controller/worker/GC/admin entrypoints check this marker and
the database gate. Existing marker, unreadable directory or absent/invalid/blocked
database state fails closed. Processes must share this persistent directory;
a missing mount is a startup error, never permission to assume readiness.
Reads and backup verification remain available.

Maintain stopped/fenced application processes throughout import and set/verify
database `blocked` after import before enabling new credentials/processes.
The external marker survives a crash between importing a dump containing `ready`
and writing `blocked`; failure to set/verify either gate aborts recovery.
P3/P4 consult both gates in every mutation transaction and before dispatch.
P5 is the only operator path to clear it after verified remote reconciliation.
Recovery sets database `ready` under recovery locks, then removes the marker and
fsyncs its directory. A crash before marker removal stays blocked; clearing
either gate alone is insufficient. Test a process death immediately after import,
before writing the database gate, and a fresh process restart.

Before archive copying or schema import, require manifest migration ID
`20261119_018_immutable_deployment_model`; error code `backup-schema-floor`.
Post-restore verification checks the actual migration table and the blocked
gate, not just the manifest. `BACKUP_FORMAT=1` remains unchanged.

Revoke every API key containing a scope whose prefix is exactly `preview:`,
including mixed-scope keys. Do not map grants to `app:*`.
Prefix matching is exact and case-sensitive: `preview:` is not `Preview:` or
`previewish:`. Unknown scopes never gain new permissions.
Already revoked keys keep their original timestamp; audit counts distinguish
affected rows from newly revoked keys and expose no hashes/secrets.
Unrelated keys and user sessions are unchanged. Runtime rejects legacy grants
even if a malformed/restored key escapes migration. New scope fixtures include
contracts, client-core, SDK/CLI/MCP and authorization callers.

## Old-process findings (executed, P1)

`immutable-old-process.spec.ts` runs the real `39fbc29` code, extracted from git
with its three source hashes checked, against a database cut over by both SQL
segments. Seven cases pass on PostgreSQL 17:

- **Control.** Before cutover the same old `claimNext` claims work (and writes
  events) and the old GC removes an unreferenced archive, so the refusals below
  are not vacuous.
- **Fails closed.** After cutover the old claim, deletion claim and artifact GC
  each fail with `relation ... does not exist`. A queued new deployment is not
  claimed, and the archive file and its row are untouched.
- **Finding 1: the fixtures give an old binary no startup refusal.** They record
  no migration, so the old `assertSchemaCurrent` still passes. With
  `20261119_018_immutable_deployment_model` recorded (simulated by inserting the
  row) it refuses at startup naming that migration. The real migration must record
  018, and P2 must keep that test.
- **Finding 2: the fail-closed behaviour is incidental.** It exists only because
  the new tables use names no old binary knows. It is not a guard, and an old
  process that is still running would fail on every poll rather than stop. The
  database-role fence is what actually removes it.
- **Finding 3: terminating sessions is not a fence.** The old login simply
  reconnects. `ALTER ROLE ... NOLOGIN` followed by `pg_terminate_backend` ends the
  held session, leaves zero sessions, and refuses a reconnect. Order matters:
  fence the login first, then terminate.

Not covered: in-flight Docker or SSH calls an old worker already dispatched, an
old process connecting as a superuser or owner role, and the old controller's API
handlers (only the worker and GC code paths were run).

## P2 verification gates (partly executed above)

- Empty, frozen schema-014 and fully retired schema-017 upgrades.
- Each nonterminal deployment/deletion state independently blocks migration;
  a terminal row with pending rollback or any leftover lease field also blocks it.
- Same-slug retired rows reserve every historical hostname/app name.
- All registry owner kinds: missing owner, missing reservation, reciprocal
  mismatch, cross-org mismatch, release/reuse and transaction-commit timing.
- Baseline worker/controller/GC cannot reconnect through old credentials;
  actual baseline SQL fails against absent old names with fixture-only access.
  Archive sentinel checks include a GC paused after candidate selection.
- Mixed/legacy/unknown-prefix/unrelated/revoked key cases and audit counts.
- Pre-model restore leaves database/archive sentinels byte-identical.
  Post-model restore preserves unfinished work but cannot dispatch/GC/delete
  until verified operator recovery, including after restart.

P1 adds retirement fixtures to the existing inventory suite; that verifies the
current read-only inventory, **not** the future migration refusals, role fence or
restore gate. The separate SQL-candidate suite verifies retirement refusals,
names/history preservation and key revocation inside isolated test transactions.
That does not prove old-login fencing, restricted-role trigger execution,
reservation closure, backup floors or recovery-gate durability. Complete model/
reservation SQL review and these P2 gates remain required before declaring cutover ready.
