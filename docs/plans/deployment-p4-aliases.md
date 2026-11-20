# P4: aliases, promotion, recovery counters and retention pins

Status: **approved 2026-11-20 as written (automatic expiry stays out). P4a is built on
`feat/deployment-p4a-aliases`; later slices are not started. Nothing here is authorized to run
against real infrastructure.** Parent: [deployment model plan](deployment-model.md), P4. Schema
contract: [replacement schema map](../design/deployment-cutover-schema.md). Behavior and the alias
and operation state machines: [deployment design](../design/deployment-modes.md). Router:
[alias router plan](production-alias-router.md) (R1 core and R2a host are built and unwired; R3
packaging and R4 integration are not). P3 ([plan](deployment-p3-deploy.md)) is complete.

## Assessment

- **Kind / risk:** Large / High. Shared mutable state (generations, pins), a remote system whose
  outcome can be uncertain, and destructive retention depend on it.
- **How much changes:** services (alias and operation allocation, pins, corrective operations),
  a router control client, a promotion runner in the worker, API and OpenAPI, admin recovery
  commands. No new table: migration 018 already holds `app_alias`, `promotion_operation`, the
  reservations and `last_unpinned_at`. Expect at most small forward migrations.
- **Unknowns:** how the control protocol behaves under lost replies (the client is new); pin
  release correctness across the superseded chain; the recovery counter protocol against a live
  router. Each gets a PostgreSQL or loopback-router test before the next slice builds on it.
- **Undo:** disable dispatch (`LAUNCHPAD_ALIASES=off`); pins stay; uncertain operations are
  reconciled under a new fenced operation. Never lower a counter, never reuse a generation.
- **Execution shape:** solo build of the shared-state core, independent read-only Opus review before
  each push, CodeRabbit and CI before each merge. The router runs in-process on loopback in tests
  (the real `apps/router` host and `packages/alias-router` store); no Docker or Dokku is needed for
  P4 checks, and no real service is started.
- **Reassessment triggers:** multi-host routing authority, custom domains, or zero-downtime
  coexistence need a new design.

Excluded: production startup, publishing, DNS or certificates, connector changes, existing
resources, the router image and Compose (R3), the dashboard, SDK, CLI and MCP (P6), restore
verification beyond the counter checks (P5), and the Dokku rehearsal (P7).

## Decisions to approve

1. **Scopes and roles.** Add `app:promote` (bind or move an alias) and `app:alias:manage` (create,
   withdraw). Deployer role and above, as for deploy and delete. Keys need the scope; project
   limits apply; no mapping from older scopes.
2. **Switch.** `LAUNCHPAD_ALIASES=on|off` (default off), valid only with `LAUNCHPAD_DEPLOYMENTS=on`.
   P4a needs only the switch, limits and hostname template. From P4c, turning it on also requires
   the router settings that `parseAppRoutingConfig` already defines (`LAUNCHPAD_APPS_PROXY_URL`, alias
   control and probe URLs, instance ID, token and epoch files), and the upgrade notes say so.
   Off: alias writes answer 503, reads work, the worker never contacts the router.
3. **Idempotency.** Every promotion or withdrawal request needs an `Idempotency-Key` header (1 to
   128 characters). The same key with the same payload returns the same operation; the same key with
   a different payload is a 409 with no side effects.
4. **Eligibility.** A bind target must be a `succeeded`, `active`, same-app, same-organization
   deployment, checked under the app lock. Deploy never promotes implicitly.
5. **Counts.** `LAUNCHPAD_MAX_ALIASES_PER_APP` (default 5) and `LAUNCHPAD_MAX_ALIASES` (default 50),
   as `parseAppRoutingConfig` already reads them.
6. **App shutdown** (withdraw every alias, then allow deployment destruction) is included as the last
   slice, resumable and blocked by uncertain routes. Automatic retention expiry (a scheduler that
   deletes unpinned, expired deployments) is **not** included: P4 records pins and
   `last_unpinned_at` only, and manual deletion keeps working. Say if you want expiry in P4.
7. **Recovery counters.** `recovery-clear` also refuses while any alias counter is below the
   router's generation or the router holds a route Launchpad does not know; a new operator command
   `recovery-raise-counters` raises counters monotonically (`GREATEST`) under the alias lock.

## Lock order

Quota advisory lock when allocating, then the app row, then alias rows ordered by UUID, then
deployment rows ordered by UUID, then operation rows. Promotion reservation, the compare-and-swap on
the expected generation, and pin creation all happen under these locks, not only finalization. No
network call inside a transaction. P3's deletion and reconcile already follow the app, deployment,
operation part.

## Ordered delivery

### P4a: aliases without routing (services and API)

Create and read aliases: generated alias hostname from the alias template, reserved in the same
transaction (hostname reservation owner kind `alias`), state `unbound`, generation 0, per-app and
per-organization counts. Scopes, switch and config parsing for aliases; routes
`POST /apps/{appId}/aliases`, `GET` list and read; OpenAPI; tests for the permission and project
matrix, quota races and hostname permanence. Nothing contacts a router.

### P4b: promotion intent, pins and corrective operations (services only)

`bind` and `withdraw` operations with `expected_generation` compare-and-swap, `Idempotency-Key`,
reserved generation advancing on intent, same-app eligibility, pre-dispatch intent, and pins:
the alias target, the previous target, and every target in the unresolved chain stay pinned; pins and
`last_unpinned_at` change under the app lock, and deletion refuses a pinned deployment. Corrective
operations: allocate a higher generation, mark the old one superseded, insert the linked operation in
one transaction. Property-style PostgreSQL tests for: CAS races, idempotent retry allocating no new
generation, payload conflicts with no side effect, bigint bounds and exhausted generations, GC and
reservation races, alias recreation never reusing a hostname.

### P4c: router client and promotion runner (worker)

A private router control client (in `packages/alias-router`) with typed, bounded calls that classify
every failure as definite or uncertain (a timeout is never proof of failure). A promotion runner in
the worker: fenced five-minute claims, intent recorded before dispatch, deadlines inside the lease,
authoritative readback checking operation ID, generation, target and epoch, then an identity probe
through the proxy; stale-generation rejection independent of leases. Every finalizing write carries
the operation ID, attempt, fence and a live lease. Tests against the real router on loopback: lost
reply, crash after dispatch, deadline, stale worker (a delayed write changes zero rows), repointing,
withdrawal. Extend `deployment-reconcile` to operations (`superseded`, corrective).

### P4d: API for operations, shutdown barrier

`POST /aliases/{aliasId}/promotions` and `DELETE /aliases/{aliasId}` (202 with the operation ID),
operation reads, OpenAPI, built-server HTTP tests. The resumable app-shutdown withdrawal barrier before
any destruction; uncertain routes block shutdown cleanup.

### P4e: recovery counters and end-to-end acceptance

`recovery-raise-counters` and the extra `recovery-clear` refusals; a restore test with the router ahead,
an unknown route and a counter below the router. The worked example from the parent plan end to end:
two aliases, promotion CAS, supersession, withdrawal uncertainty, pin and GC races, all against the
real router on loopback. Update install, restore, upgrade, tooling and the deployment guide.

## Risks

| Risk                                                      | Control                                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Delayed worker or router write with premature pin release | Every write fenced by operation ID, attempt, fence and live lease; router rejects stale generations; pins released only under the app lock after verified readback |
| Timeout treated as failure                                | Classified uncertain; blocks new operations for that alias until reconciled                                                                                        |
| Generation reuse or overflow                              | bigint, decimal strings in every contract, gaps allowed, exhaustion fails closed                                                                                   |
| Lock-order drift                                          | One documented order, tested; P3 paths already match                                                                                                               |
| Restore lowers a counter                                  | Counters only rise (`GREATEST`); clear refuses on a router mismatch                                                                                                |
| Real infrastructure touched                               | Not in P4; loopback router only                                                                                                                                    |

## Verification and approval

Each slice: `omni -i run check test build test:integration` on disposable PostgreSQL (stopped
afterwards); image, upgrade and package gates where touched; independent read-only review before each
push; CodeRabbit and CI before merge.
