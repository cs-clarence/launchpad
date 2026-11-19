# Immutable deployment model implementation

Status: **P1 in progress after user approval**, 2026-11-19.
For implementers and reviewers; this plan defines safe delivery boundaries, not
operator instructions. No runtime changes are authorized by this document alone.

## Goal, scope and assessment

Deliver the [immutable deployment design](../design/deployment-modes.md):
one remote app/image/URL per deployment, independently movable aliases, and no
destruction of a possibly routed target. The router prerequisite landed in
PRs #53 and #54; its [accepted evidence](routing-experiment-evidence.md) does not
prove application-database concurrency.

- **Kind / risk:** Large / High.
- **How much changes:** database/history, services, worker, admin recovery,
  authorization, API/OpenAPI, dashboard, SDK, CLI, MCP, fixtures and operator docs.
- **Unknowns:** the router is proven; application claim fencing, pin-chain
  finalization, migration compatibility and restore reconciliation still need
  executable proof. Investigate these before expanding the client surface.
- **Undo difficulty:** easy before migration; after it, matched old binary and
  pre-upgrade backup in isolation, never a down migration or an old worker against
  the new database. Remote alias state requires separate fenced reconciliation.
- **People / time:** one integrating author and independent Opus review at each
  nontrivial push; multiple reviewable PRs, not a one-session change. No fixed
  delivery estimate until the concurrency slice is proven.
- **Execution shape:** solo implementation of the shared-state core, independent
  read-only review. Split client work only after contracts settle and only if the
  briefing/integration cost is worthwhile.
- **Checks:** narrow unit/integration gates per slice; full
  `omni -i run check test build` at each integrated PR boundary, plus affected
  image/upgrade/package gates and final authorized disposable rehearsal.
- **Next:** independent review of this plan, revise it, then obtain approval for
  the first implementation slice.
- **Reassessment trigger:** multi-host routing authority, active-preview conversion,
  runtime/container builds, custom domains or zero-downtime old/new coexistence
  require a new design. There is no larger size tier; widen the plan explicitly.

Excluded: production startup, publishing, DNS/certificate automation, connector
changes and deletion of existing resources. Previously authorized experiments do
not authorize broad cleanup.

## Observed baseline and choices

- `packages/database/src/migrations/` has 17 forward-only migrations.
  `deployment` and `deletion_operation` currently reference mutable `preview`.
  `deployment_event` references the existing deployment table.
- `assertSchemaCurrent` rejects missing/unknown migrations at process startup.
  `apps/worker/src/index.ts` checks once before starting its loop: this is **not**
  a fence for a previously running old process.
- `apps/worker/src/worker.ts` calls the current deployment and lifecycle runners;
  scheduled lifecycle currently gates the deletion loop too. Explicit deletion
  must become independently runnable.
- `apps/controller/src/admin/restore.ts` rejects unknown manifest migrations
  before copying archives, but has no immutable-model minimum migration.
- Slice 0 hostname/config/drift helpers exist but are not runtime wiring.
  The design is authoritative for lock order, scope matrix and retention formula.

**Chosen cutover:** coordinated pre-release maintenance, not dual writing.
Keep legacy rows as `legacy_*` history and build a distinct immutable schema.
Do not convert mutable previews or have old and new workers share queues.
An additive preparation PR can remain inert. The actual table retirement,
runtime disabling and restore floor must land together in a runnable cutover PR.
It may temporarily offer app/history reads with mutations unavailable until the
following slices; report that limitation explicitly, never fall back to previews.

Rejected: reuse existing rows as immutable deployments (ownership/rollback
ambiguity); maintain both active deployment models (doubles safety paths); rename
tables without replacing worker/GC callers (old SQL can target new resources).

New physical queue tables are `immutable_deployment`,
`app_deployment_event` and `deployment_deletion_operation`; never reuse
`deployment`, `deployment_event` or `deletion_operation`, even as compatibility
views. The design's deployment terminology denotes resources, not old SQL names.

The cutover runbook must stop controller writers, workers and admin/GC jobs and
settle bounded remote calls. Before migration, an operator fences the old database
login with `NOLOGIN`, terminates its existing backend sessions and verifies their
absence, using a separate maintenance principal. New processes use a distinct
non-inheriting application login; do not re-enable the old login. This requires
explicit operator authorization and privileges, not automatic role modification
inside the schema migration. Inventory additional writer roles and poolers too;
an unfenced privileged writer blocks cutover. Database fencing cannot cancel an
already dispatched Docker/SSH call: process shutdown and remote settling remain
mandatory before accepting retirement preconditions.

The migration takes explicit locks and refuses live previews or unfinished
deployment/deletion/rollback work. Fresh heartbeats are an additional refusal
signal, not proof of exclusion. Test old worker, controller and artifact-GC
entrypoints from the actual `e03c542` artifact against the migrated fixture, both
with a held old connection and attempted reconnect. They must lose access under
the role fence. Separately, with test-only access, actual old claim/write SQL
must fail against absent old table names, never claim new work. Preserve the
old artifact and its provenance; a hand-written approximation is not this test.

## Worked acceptance example

Organization O owns project P and app W. Upload once and deploy A and B into
different opaque Dokku names and unique hostnames. Bind production and staging to
A, promote only production to B, then roll it back to A: image identities and
build counts never change. Failed candidate C cannot reload A or change either
alias. Domain/template changes affect only future allocations.

Two callers promote production at the same expected **reserved** generation:
exactly one intent is accepted. Race that reservation with deletion of B: either
the pin wins and deletion refuses, or deletion marks B deleting and promotion
refuses. Delay an authenticated routing write, expire/reclaim its worker claim,
and prove the stale worker cannot finalize database state or undo a newer router
generation. Lost acknowledgement pins both candidates until authoritative readback.

Supersede an uncertain A→B operation with B→C, then make correction uncertain:
retain every possible target across the chain. Withdrawing one of two aliases
does not unpin A. Verified final withdrawal releases the last pin and starts the
rollback window; scheduled GC waits for the later deadline. Manual DELETE may
waive time only, never pins. Restore an older post-model backup while the router
has a newer acknowledged generation: close ingress, fence epoch/credentials,
reconcile and raise counters before enabling mutations. Reject a pre-model
backup without changing database or archive files.

## Ordered delivery

### P0 — plan and review (complete for starting P1)

Review migration boundaries, stale-process safety, router contracts, pin closure,
restore gate and the example above. Close blocking findings before coding.
Check: independent reviewer says whether P1 is ready. Undo: discard the draft.

Opus's first review conditionally accepted P1 after table-name and old-process
fencing corrections, and blocked P2 pending those plus restore-gate and
reservation detail. This revision addresses all five findings in the plan;
the concrete SQL map and runnable tests remain P1/P2 gates, not completed proof.

### P1 — inert safety fixtures and cutover specification

User approved continuing P1 after rebasing onto `main` and syncing projections.
The [schema map](../design/immutable-cutover-schema.md) now records retirement,
identity sources, physical table contracts, role fencing and restore-gate ordering.
The inventory suite adds real-schema fixtures for every unfinished legacy
deployment/deletion status and slug-reused retired identities. These exercise
existing inventory behavior only; migration SQL, key/floor fixtures and frozen
baseline artifact execution are not yet implemented or claimed as verified.
The second Opus review found inventory/migration predicate disagreement and
order-dependent tests. Fixed: each test has an isolated database; inventory now
blocks any non-null pending-step/lease field even on terminal jobs, without
using expiry as evidence of settling. With explicit user approval, the
disposable PostgreSQL reproduced 11 failing cases before the fix; all 25 cases
passed after it. The database fixture was removed with `test:db:down`.
No Dokku or controller server was started.

Next P1 increment: the executable retirement segment lives only in controller
admin test fixtures (`immutable-retirement.sql`), not the migrations directory.
It locks/refuses unsettled legacy work, rejects noncanonical historical hostnames,
checks the real object-name inventory, preserves table/FK/sequence history through
renames and revokes exact legacy API-key prefixes with audit counts. Integration
tests also exercise atomic failure and later-segment rollback. Model tables,
reservation triggers, role/old-artifact fencing and restore-floor/gate fixtures
remain outstanding; this segment must never be used alone as a cutover.
With explicit user permission, `test:cutover:retirement` passed all 40 cases and
`test:inventory` passed all 25 cases against disposable PostgreSQL on loopback 55432. The full `omni -i run check test build` gate passed (98 tasks, 83 cache
hits). The test container was removed through `test:db:down`; neither Dokku nor
the controller server ran. The independent review of that segment follows below.
Opus conditionally accepted the segment as a prerequisite for drafting model/
reservation SQL, not for shipping P2. Its four findings are addressed:
typed catalog filtering and an explicit PostgreSQL-17 test contract, direct
legacy Dokku-name validation, accurately limited catalog-coverage claims, and
specific failure/rollback assertions. The revised candidate passed all 45 cases
on disposable PostgreSQL 17; the container was removed again. PostgreSQL 18 is
not claimed as supported or tested. No additional independent re-review is
claimed; the author checked these bounded corrections directly.

After the authorized restoration of PRs #50–#54 to `main`, P1 continues with
`immutable-model.sql` and its dedicated `test:cutover:model` suite. The test-only
candidate creates the eight model/registry tables, composite FKs, immutable
identity/intent guards, deferred reciprocal checks and permanent legacy seeds.
It must run in the retirement transaction while its exclusive locks remain held.
It records no migration 018 and installs no recovery gate or production grants.
Restricted-role execution, old-artifact/login fencing, backup floors and the
restore-gate fixtures remain outstanding. Review of this new segment is required
before it becomes a prerequisite for P2.
Verification: 44 model/reservation, 45 retirement and 25 inventory cases pass
together on disposable PostgreSQL 17. Full `omni -i run check test build` passes
(98 tasks, 83 cache hits). The PostgreSQL container was removed with
`test:db:down`. No controller/Dokku server was started, no migration 018 was
installed/recorded, and none of the uncommitted P1 work was pushed to `main`.
Opus conditioned model-segment acceptance on adding TRUNCATE guards.
The two new regression cases first reproduced successful truncation of permanent
registry/legacy data. Added BEFORE TRUNCATE statement guards on all twelve
model/registry/legacy tables; both cases now pass. Also tightened append-only
events, manual-deletion attribution, irreversible deletion state, retirement-only
release auditing and settled promotion links. The suggested supersession
equivalence was not adopted: a linked uncertain predecessor must remain
unfinished until the corrective barrier is verified. The expanded model suite
passes 57 cases on PostgreSQL 17; its disposable container was removed.
Ten further cases then exercised the model under test-only definer and application
roles (the definer owns the validators; the application role owns nothing and
cannot truncate, delete history, disable triggers, bypass them via
`session_replication_role`, or execute a validator): all 67 model cases pass on
PostgreSQL 17. The first run of those cases failed in teardown only (dropping the
definer's functions while triggers depended on them); teardown now reassigns
ownership first. The failed run's leftover test roles and databases lived only in
the disposable container, which was removed. The real production roles and grants
are still P2 work, and old-artifact/login fencing and the restore floor and
recovery gate remain outstanding.

Old-process compatibility is **partially** executed (`test:cutover:old-process`, 8 cases
on PostgreSQL 17). The real `e03c542` claim, deletion claim and artifact GC were run
as the database owner against the cut-over schema and fail closed with the relation
named, leaving the archive, its row and new-model rows untouched; a control shows the
same code does act before cutover. The fence mechanics (`NOLOGIN`, then session
termination, then a refused reconnect) were exercised on a raw client with a test-only
role, **not** through old entrypoints. Not done: the old controller's API handlers, old
entrypoints run under the fenced role, a built artifact, and in-flight remote calls.
The baseline is the old **source plus the current third-party dependencies**, not a
built artifact and not installed from its own lockfile. A runtime assertion proves its
workspace packages resolve inside the extracted tree; a mutation check (relinking
`database` to the current package) was shown to fail that test.
Two findings change P2: the SQL fixtures alone give an old binary **no startup
refusal** (migration 018 must be recorded, and then it refuses), and the fail-closed
behaviour is **incidental to unused table names**, so the role fence stays mandatory.
Terminating sessions without `NOLOGIN` is shown not to fence.

The third independent review accepted P1 as an inert PR after documentation fixes
(done here) and listed what P2 must still prove before any cutover:

1. **Record 018 as a real Kysely migration.** The migrator runs all pending migrations
   in one transaction under `launchpad_migration_lock` and inserts the row in it, so the
   fixtures' own transaction wrappers go, a 017+018 run in one go is tested, and the
   inserted-row test is rewritten against the real migration.
2. **Rewrite every service that reads legacy tables** (`deployments`, `deletions`,
   `previews`, `drift/*`, `status`, `expiry`, `lifecycle-run`, `artifact-gc`, the worker,
   `inventory`, `restore`, `live/restore.live.ts` and the `Database` types), or new
   binaries fail with the same missing-relation error the old ones do.
3. **Real roles and grants** (non-login definer, distinct application login, no rights on
   `legacy_*`), with old entrypoints run under the fenced role.
4. **Floor and gate**: `backup-schema-floor` beside the unknown-migration check in
   `restore.ts`, the marker written and fsynced before archive copying, the database gate
   set and verified after `pg_restore`, `verifyRestored` asserting both, and a test that
   kills the process right after import and restarts.
5. **Idempotency replay**: `idempotency_key.resource_id` is a bare UUID scoped only by
   endpoint, so new endpoints must use new names and a fixture must show an old key
   cannot replay into a new resource.
6. **In-flight requests**: a held transaction that commits after fencing.
7. **`lock_timeout`** on the migration, so a straggling old session fails it rather than
   queueing an exclusive lock behind every reader; and the full dependency inventory
   (incoming FKs, views, grants, constraint definitions).
8. CI must have full history for `git archive e03c542`: the integration job now uses
   `fetch-depth: 0`, and the spec fails with an explicit message in a shallow clone.

Add regression fixtures for legacy retirement refusal, API-key revocation,
pre-model backup refusal and stale claims. Specify the exact immutable migration
ID (`20261119_018_immutable_deployment_model`), legacy rename/constraint map
and new table SQL before building the cutover.
Do not add a migration that activates the new model in this preparation PR.
Keep the baseline runnable; tests for future behavior belong with the implementing
change rather than leaving failing tests on main.
The old worker and GC source compatibility test is **active now**
(`test:cutover:old-process`, extracting `e03c542` from git). Old controller-handler and
fenced-role entrypoint tests are P2 work. The backup floor and recovery gate need
migration 018 and are P2, not P1.

Checks: fixture integrity and existing upgrade/unit gates; SQL review of all
organization-qualified FKs, reciprocal hostname deferred triggers, cross-model
Dokku-name reservations and preserved history. Undo: revert inert preparation.

### P2 — maintenance cutover and safe read-only model

One coordinated PR: retire `preview`, `deployment`, `deployment_event` and
`deletion_operation` into explicitly named legacy history; preserve keys/FKs and
history without cascading hostname/name loss. Create the app/deployment/alias,
reservation and operation schema from the design, using the distinct physical
names above. Seed all legacy names/hosts
before permitting allocation; keep permanent name ownership across both models.
The SQL map must enumerate each source column, including deleted/tombstoned
previews, slug-reused predecessors and recorded rollback targets. Check set
coverage of every distinct recorded Dokku name and hostname, not only live rows.
Hostname reservations use `owner_kind=legacy_preview`; the SQL map must separately
specify permanent cross-model Dokku-name reservation and uniqueness enforcement.
Remove legacy worker/GC selection and mutation entry points. Do not leave
artifact collection reading only the new deployment table.

Install the exact migration-ID restore floor before any restore mutation.
In `admin/restore.ts`, require `manifest.migrations` to contain
`20261119_018_immutable_deployment_model` before archive copying or `pg_restore`,
with a distinct `backup-schema-floor` error code. `verifyRestored` also asserts
the floor against the restored schema.
Create the persisted installation mutation gate in this slice. Restore sets it
before any restored work can run, regardless of whether the backup has unfinished
operations; do not trust a gate value from the dump. A failed/interrupted restore
must leave recovery blocked. Keep application processes stopped/database-fenced
through restore; only explicit verified operator recovery clears the gate.
P3/P4 must check it on enqueue, claim, dispatch, deletion and GC from their first
implementation. Until P5 supplies recovery, a restored installation remains
blocked, not temporarily operational.
Keep format 1; pre-upgrade backups remain possible with explicit previous-binary
restore warnings. Revoke keys with any `preview:*` grant with audit counts; reject
legacy scope issuance/authentication, without revoking unrelated keys or sessions.
Wire canonical configuration and reject obsolete settings together with examples,
tooling and affected fixtures. New mutations remain unavailable until implemented;
deployment/routing/retention default off. Legacy history stays operator-readable.
Retired preview endpoints return an explicit 410 response rather than accidental
500s; the dashboard explains the maintenance transition. Update contracts,
client-core and scope fixtures alongside revocation; full new client UX is P6.

Checks: real PostgreSQL migration from empty, frozen schema-014 and retired
schema-017 fixtures; refusal of every active/uncertain legacy state with no partial
schema change; held old claim cannot write/dispatch into new resources; deferred
reservation constraints at commit, quota/name collisions, key scope isolation;
pre-model restore leaves sentinel DB/files checksums unchanged; post-model backup
round trip preserves unfinished operations but leaves the mutation gate set.
Exercise actual old artifact GC as well as old worker claims under the role fence,
including reconnect attempts; tests never change production roles.
Update image and built-artifact upgrade drills in this PR, not later.
Undo: before migration revert binary; after migration stop everything and restore
the matched old backup/binary under closed ingress. No in-place downgrade.

### P3 — deploy and delete one immutable candidate end to end

Expose app create/read and immutable deployment upload/enqueue/read through
services/API and minimal SDK fixture. Worker builds/loads/verifies only its fresh
recorded app; remove mutable rollback reload. Persist exact image identity and
hostname; failed/uncertain work touches only owned resources. Share app locking
with guarded deployment deletion, including manual deletion with scheduling off.
Artifact GC protects both retained immutable and legacy references.

Checks: PostgreSQL queue/lease/reclaim tests plus real worker-port stale-claim
test; two deployments have distinct remote identities; a failed candidate cannot
reload an earlier target; uncertain load/destroy remains reconcilable; exact-name
cleanup, archive references and allocation quota races. Integration through the
built API and worker adapters, not only mocked router calls.
Undo: disable new jobs and drain/reconcile claims; retain records/resources.

### P4 — alias operations, recovery and retention end to end

Add generated alias allocation, promotion/withdrawal CAS and idempotency,
five-minute fenced claims, pre-dispatch intent, private router client and identity
probes. Same-app/org target eligibility and shared lock order apply everywhere:
quota advisory transaction lock first when needed, then app row, aliases ordered
by UUID, deployments ordered by UUID, operation rows. Promotion reservation/CAS
and pin creation occur under these locks, not only finalization.
No network I/O inside SQL transactions. Never translate a timeout into proven
failure. Authoritative readback checks operation ID, generation, target and epoch;
probe identity alone is insufficient.
Every operation finalizing UPDATE includes operation ID, attempt/fence and live
lease in its WHERE clause. The stale-worker test exercises an actual state write
and proves zero affected rows, not only a router-generation rejection.

Implement corrective higher-generation operations with full superseded-chain pin
closure; commit pins and `last_unpinned_at` under the same app lock as deletion.
Implement app shutdown as a resumable withdrawal barrier before any deployment
destruction. Uncertain routes block shutdown cleanup, not just scheduled expiry.

Checks: the worked example's CAS, GC/reservation race, two-alias, supersession,
withdrawal uncertainty, crash-after-dispatch, deadline, stale-worker and bigint
cases on PostgreSQL plus production-router adapter integration. Verify retention
boundary equality, alias recreation cannot reuse hostname, exhausted generations
fail closed, idempotent retries do not allocate another generation, and request
payload conflicts have no side effects.
Undo: disable dispatch and GC, keep pins; reconcile under a new fenced operation.

### P5 — restore reconciliation and operator drift

Complete recovery for the persisted post-restore mutation gate installed in P2
and enforced by P3/P4, not a status/report convention. Provide
an operator-only procedure/command that uses rotated epoch/credentials, compares
complete durable router state including tombstones, raises reserved counters and
protects unknown routed targets. Never silently discard unknown routes or enable
GC while any target ownership is unresolved. A fresh router requires explicit
offline bootstrap, not HTTP epoch reset.
Raise counters monotonically with `GREATEST` under the alias lock while the gate
is set; never lower a counter to match an older snapshot.

Wire read-only drift readers/allowlisted Dokku reads to the existing pure comparer.
Keep findings advisory and installation-operator-only. Scheduling stored drift
findings is a separate optional follow-up, not a prerequisite for safe routing.

Checks: post-model restore with router ahead, unknown target/alias, missing
tombstone, epoch mismatch, lost router state and repeated interrupted recovery.
Mutation gate survives restart and refuses every mutation path until explicit
verified reconciliation. Pre-model refusal and format-1 integrity remain tested.
Undo: keep ingress closed and gate set; retry reconciliation, never lower counters.

### P6 — coordinated client and documentation cutover

Finish API/OpenAPI, app/alias dashboard, SDK, CLI and MCP together against the
settled contracts. Remove `/previews` as an active contract with explicit breaking
release notes. Deploy never promotes implicitly. Require independent key scopes,
project checks, session-only recent-auth reconciliation and explicit MCP promotion/
alias-management startup opt-ins and confirmation. Update examples and install,
upgrade, backup/restore, tooling and package-pattern docs with actual commands.

Checks: role/scope/project matrix, schema parity, built-server HTTP and CLI/MCP
tests, negative confirmation tests, packed clients under Bun/Node and UI logic.
Undo: disable mutations or roll back clients to the preceding compatible
immutable-model version, not the retired preview API.

### P7 — independent acceptance and disposable rehearsal

After explicit service-start authorization, exercise the worked example through
built controller/worker/router images on disposable PostgreSQL/Dokku, including
stale-worker dispatch and all pin/GC races. Record credential-free evidence and
exact resource inventory/cleanup, review with Opus, then resolve CodeRabbit and CI
before merging. Production Compose/install/upgrade rehearsal remains its own
[follow-up](production-compose-follow-up.md); no production rollout here.

Checks: full local gate, affected integration/image/upgrade/package gates, accepted
rehearsal evidence, zero unowned cleanup. Undo: exact recorded fixture cleanup only.

## Risks and remaining gates

Highest risk is a delayed worker/router write combined with premature pin release;
P1/P2 test database fencing and P4 proves routing/GC closure before clients expand.
Other High risks: table rename/FK mistakes, archive GC losing history references,
key privilege escalation and restoring stale state with live mutation dispatch.
Each has an explicit gate above; no router-only test substitutes for worker tests.

The integrating author owns migration SQL and review responses. Independent Opus
owns review findings, not acceptance authority. The user owns implementation
approval and operator production choices. Exact ingress domains/storage/networking
do not block planning or unit fixtures and remain unset.

Readiness: P1 is approved and underway. **P2 is not ready to build**: it requires
the reviewed executable migration/constraint map and remaining P1 fixtures.
No immutable-model migration has run and nothing has been committed, pushed or
published. Only the explicitly approved disposable PostgreSQL fixture ran and
was cleaned up.

Design delivery mapping: original Slice 0 is complete; Slice 1 router/evidence
is complete; original Slice 2 spans P1–P4 and the P6 interface cutover; Slice 3
operator recovery/drift maps to P5 (scheduled drift storage remains deferred);
Slice 4 acceptance maps to P7 and the separate production-Compose follow-up.
