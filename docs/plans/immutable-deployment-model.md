# Immutable deployment model implementation

Status: **P2 planning; revised 2026-11-19 to replace rather than retire the previews.**
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
  pre-upgrade backup in isolation (the preview data is dropped by design), never a down
  migration or an old worker against the new database. Remote alias state requires separate fenced reconciliation.
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
  `deployment` and `deletion_operation` currently reference mutable `preview`;
  migration 018 drops all four preview-era tables.
- `assertSchemaCurrent` rejects missing/unknown migrations at process startup, so an old
  binary is refused once 018 is recorded. It is not a fence for a process already running.
- `apps/worker/src/worker.ts` calls the current deployment and lifecycle runners; P2a removes
  them and idles the worker. Explicit deletion becomes independently runnable in P3.
- `apps/controller/src/admin/restore.ts` rejects unknown manifest migrations before copying
  archives. It needs the recovery marker and gate for restores that hold the new model.
- Slice 0 hostname/config/drift helpers exist but are not runtime wiring.
  The design is authoritative for lock order, scope matrix and retention formula.

**Chosen cutover (revised 2026-11-19): replace, do not retire.** Nothing is in
production, so the user dropped the legacy runtime. Migration 018 drops the preview tables
and their data **unconditionally**: no `legacy_*` history, no reserved legacy identities, no
retirement guard, no old-process fencing, no `410` stubs and no backup floor. It does not
touch Dokku; the operator removes any remaining apps by exact name. The earlier
retirement design and its test-only SQL (P1, merged in #55) are superseded and deleted by
P2. Remote alias state still needs separate fenced reconciliation after any restore.

Delivery order is "retire first": `main` may be unable to deploy between P2 and P3. The new
tables use names no old binary knows, so a surviving old process cannot operate on new
rows, and the startup check refuses new starts once 018 is recorded. Neither stops a process
that is already running or a Dokku operation it already dispatched: the operator stops all old
processes and settles in-flight remote work before upgrading. See the [P2 plan](immutable-p2-cutover.md) and
the [replacement schema map](../design/immutable-cutover-schema.md).

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
reconcile and raise counters before enabling mutations. An older dump restores and
migrates forward, and the restore still writes the recovery marker.

## Ordered delivery

### P0 and P1: planning and verification of the table contracts (complete)

Planning and three independent reviews, and PR #55: a test-only specification of the table
contracts, guards and registry rules on real PostgreSQL. The retirement parts of that work
were superseded by the 2026-11-19 decision above; the verified contracts carry into P2.

### P2: replace the previews with the model's schema

Split into three PRs in the order **code first, schema second**: (a) remove the legacy
runtime with the schema untouched, (b) migration 018 with its readers and the recovery gate,
(c) the configuration break. Full plan, risks and checks: [P2 plan](immutable-p2-cutover.md).

### P3 — deploy and delete one immutable candidate end to end

Expose app create/read and immutable deployment upload/enqueue/read through
services/API and minimal SDK fixture. Worker builds/loads/verifies only its fresh
recorded app; remove mutable rollback reload. Persist exact image identity and
hostname; failed/uncertain work touches only owned resources. Share app locking
with guarded deployment deletion, including manual deletion with scheduling off.
Artifact GC protects archives referenced by retained immutable deployments.

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
Recovery during P4: with aliases present, `recovery-clear` also refuses while any
alias counter is below the router's generation or the router holds an unknown route, and
`recovery-raise-counters` raises counters monotonically before it can pass.
Undo: disable dispatch and GC, keep pins; reconcile under a new fenced operation.

### P5 — restore reconciliation and operator drift

Complete recovery for the persisted post-restore mutation gate installed in P2
and enforced by P3/P4, not a status/report convention. P3 ships an interim
operator attestation for `recovery-clear` that is always required once a writer exists
(not dependent on a file or on table contents) and that covers closing ingress, rotating
the router epoch and credentials, and reconciling router and Dokku, as the schema map
spells out; P5 verifies the epoch change from the backup manifest; P4 adds a router-read counter check and a
monotonic `recovery-raise-counters` step; P5 replaces the attestation with verified
reconciliation. Provide
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
verified reconciliation. An older dump restores and migrates, and the restore still writes the marker.
Undo: keep ingress closed and gate set; retry reconciliation, never lower counters.

### P6 — coordinated client and documentation cutover

Finish API/OpenAPI, app/alias dashboard, SDK, CLI and MCP together against the
settled contracts. Finish the app/alias UX over the removed `/previews` contract (P2a removes it) with explicit breaking
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
P2b tests the schema guards and P4 proves routing/GC closure before clients expand.
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
