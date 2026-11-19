# Production alias router implementation

## Goal, authorization and assessment

Continue the approved immutable-deployment preparation on draft PR #53. The user
said “Go continue” after the remaining work and the production-router next step
were described. Production startup, publishing, DNS/connector changes and broad
cleanup remain unauthorized.

This is the routing portion of the existing **Large / High-risk** change:
`docs/design/deployment-modes.md`. The disposable Bun/SQLite feasibility run and
independent Opus evidence review passed; see `routing-experiment-evidence.md`.
The prototype is evidence, not code to ship.

## Approach and boundaries

Use a single authoritative Bun process with SQLite WAL and `synchronous=FULL`.
The experiment demonstrated the necessary generation, persistence and epoch
behavior. A stock proxy alone does not supply this control contract; PostgreSQL
would add a runtime dependency without removing the need for a routing authority.
Keep the routing authority's durable state separate from the controller database.

Build a small private `@launchpad-kit/alias-router` core first, with no listener or
automatic startup. Then add the `apps/router` control/data-plane host, client,
operator commands, image and integration checks. The core is independently
testable through its authenticated operations; it is not a production-readiness
claim on its own. No schema migration or existing worker/controller behavior
changes in this first increment.

### Core contract (R1)

- Explicit initializer creates a **new** state file, schema version and initial
  instance/epoch/credential hash. Opening existing state never creates or repairs it.
  Require a private, owned, physical state directory and regular mode-0600 file.
  Create exclusively (`wx`), then initialize schema and complete metadata in one
  transaction. Interrupted/incomplete metadata is unsupported, never completed
  during open. The operator supplies the initial random token; the core never
  generates, returns or logs a plaintext secret.
- Secrets are random 32-byte lowercase hex tokens. Hash before storing or retaining
  an authenticated handle; compare fixed-size digests in constant time. Errors and
  returned state never contain credentials or hashes.
- `authenticate({instanceId, epoch, token})` returns an opaque, store-owned writer
  capability. Every mutation revalidates its authority inside a synchronous
  `BEGIN IMMEDIATE` transaction. No await, hooks or externally supplied callback
  exists between that check and commit. Forged or foreign-store handles fail closed.
- A local-only `rotateAuthority({epoch, token})` transaction changes both together,
  retaining all routes and generations. Persist used epochs and token hashes to
  refuse their reuse. The future HTTP adapter must **not** expose this operation:
  it belongs to the operator process with direct state-file access.
  Instance identity never changes. Epochs are opaque lowercase UUIDs, not ordered
  counters: fresh/non-reused is required, not UUID lexical ordering. Rotation
  invalidates every prior handle across open store objects; a handle belongs to
  its exact open object and is invalid after close/reopen.
- Authenticated `registerDeployment({deploymentId, hostname})` admits a generated
  one-label hostname under the configured apps domain. It records immutable target
  identity, not a caller URL, address or proxy directive. An identical registration
  is idempotent; reassignment conflicts.
- Authenticated `replaceRoute({aliasId, hostname, operationId, generation,
  targetDeploymentId})` binds a registered target or writes a null tombstone.
  The first authenticated bind/withdraw reserves the hostname and alias identity;
  generation 0 remains backend-only. Alias and deployment ownership share one
  reservation registry, including all tombstones.
  New aliases use the same canonical ASCII lowercase/no-trailing-dot, one-label
  admission rules as deployments. An alias ID with a different hostname, or a
  hostname owned by any other identity (including tombstones), conflicts.
- Generations are canonical positive decimal strings, capped at PostgreSQL bigint
  maximum `9223372036854775807`. Compare with `BigInt`, never JavaScript numbers.
  Higher generations apply, exact latest-operation replay is idempotent; lower or
  conflicting equal generations return conflict without changing state.
  Retain committed operation identities/payloads to reject operation-ID reuse with
  different contents. Any non-latest replay conflicts; R2 must read authoritative
  state to classify it as superseded rather than assuming it never applied.
  Reaching maximum generation permanently exhausts that alias's writable counter.
- Existing registered hostnames survive configuration changes; only new admission
  uses the current apps domain. No hostname/identity reuse or target removal in R1.
  Apps domain is passed when opening state, not persisted as an admission policy.
  The backend later enforces same-app membership, deployment eligibility and pins;
  this core trusts its authenticated worker for those application facts.
- Authoritative reads return current epoch plus exact route identity, operation,
  generation and immutable target hostname. Unknown routes return no mapping;
  tombstones remain distinguishable to the control plane. Neither selects upstream.
- Check state path identity, ownership and permissions on operations. Missing,
  replaced or inaccessible database/durable state must report unavailable rather
  than serving a cached mapping. Close on corrupt/unsupported state; never fall back.
  Snapshot directory/database/sidecar dev/ino, owner and permissions with `lstat`,
  refusing symlinks. Require directory 0700, database and owned WAL/SHM files 0600;
  normalize fresh sidecar permissions inside the private directory. Check identities
  during reads and inside mutation transactions immediately before commit.
  Set bounded `busy_timeout`, `trusted_schema=OFF`, schema version checks and an
  integrity check on open. Do not expose or enable extension loading.
- Library import performs no I/O. Initialization/opening are explicit. One process
  owns routing; immediate transactions additionally serialize local operator writes.

### Worked acceptance example

Initialize instance I / epoch E1 / token K1. Register immutable deployments A/B;
bind alias X generation 1 to A and alias Y generation 1 to A. Move X at generation
2 to B, then 3 back to A; Y never changes. Authenticate a writer and pause its
caller. Commit a higher-generation barrier, then submit its old generation:
conflict. Authenticate another writer, rotate to E2/K2 with the local operator
API, then submit its unseen higher generation: unauthorized at commit.

Close and reopen state; both mappings, ownership and epoch survive. Withdraw X;
reopen again; its tombstone/generation still fence old binds. Missing state,
permissions removed, a replaced database path, unsupported version, malformed
payloads, invalid handles and conflicting identities all fail closed. A maximum
generation is accepted; overflow and noncanonical strings are rejected.

## Delivery, checks and undo

| Increment                   | Outcome and verification                                                                                                                                                                                                                                             | Undo / gate                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| R1: core                    | Generator-created private package, strict input schemas, durable authority/registry/route operations, filesystem + SQLite fixture tests without listeners. Opus review of design before building and implementation before push; Omni `check test build`             | Additive/unwired; remove package without changing existing runtime or application DB                                        |
| R2: host/client             | Separate private control and public data listeners; bounded authenticated API, fixed-404 routing, trusted Host/SNI, streaming/header/time/resource limits, validated settings, explicit init/rotate commands with secret files; client classifies uncertain outcomes | No fault hooks, generic proxy endpoints or HTTP epoch rotation; review and isolated integration tests before runtime wiring |
| R3: packaging/rehearsal     | App-local Dockerfile, unprivileged state ownership, image checks and a repeat of the accepted router scenarios against the production implementation                                                                                                                 | Disposable services only; exact resource inventory/cleanup; production untouched                                            |
| R4: application integration | Original immutable-model slices 2–4: migration/retirement, worker/promotion/retention, all clients, Compose and restore rehearsal                                                                                                                                    | Stale-worker-claim, pins/GC and restore counter reconciliation remain mandatory gates; no mixed-version workers             |

R2 must enforce a single service owner (an exclusive process lock or equivalent).
R1's immediate transactions serialize local operator writes but do not themselves
enforce one process. An older restored copy of router state can resurrect an old
epoch/credential; R4 must establish a fresh epoch/credential and fence ingress
before opening mutations, not rely on R1 to detect an offline rollback.

## Open questions and exclusions

- Production ingress domains, storage provisioning and deployment networking remain
  operator choices. They do not block a private, unwired R1 core.
- R2 must enforce management/apps registrable-domain separation and keep control
  transport private (or explicitly authenticated TLS); R1 has no network surface.
- SQLite behavior under physical power loss depends on storage honoring fsync.
  Tests prove process/reopen and transaction behavior, not hardware guarantees.
- No replicas, external custom domains, ACME/DNS integration, metrics backend or
  automatic repair. No feature flag silently adopts the experimental service.

## Progress

- Opus design review accepted R1 after six clarifications above (admission,
  replay classification, authority/handle lifecycle, sidecars/identity checks,
  exclusive atomic initialization, and configuration policy).
- R1 implemented in `packages/alias-router` (39 tests on real SQLite files). Mutation checks confirmed
  that removing the commit-time authority check, or the file-identity check, fails tests. Opus implementation review: no blockers. Fixed
  its findings: lock contention is retryable instead of latching the store closed, credential hashes
  are constrained to lowercase hex, stale rollback journals are refused, and a failed initialization
  removes only what it created (5 tests added; 44 total). Left as optional: opening sidecars with
  `O_NOFOLLOW` before `fchmod` (the directory is owner-only 0700 and re-checked). Nothing is wired
  into the controller or worker.
