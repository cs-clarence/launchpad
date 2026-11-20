# @launchpad-kit/alias-router

The durable, generation-checked routing authority for immutable-deployment aliases
(R1 of [the production router plan](../../docs/plans/production-alias-router.md)).
For contributors building the router app (R2b) and the worker client. **Private, Bun-only,
not wired into the controller or worker, and not a production service on its own:** nothing in
this package binds a port, reads the environment or starts anything; the app that does is R2b.

## What it guarantees

- **Explicit state.** `initializeRouterState` creates a new state file exclusively; `openRouterState`
  only opens complete, existing state and never creates, completes or repairs it.
- **Authority at the commit.** `authenticate` returns an opaque in-process writer. Every mutation
  rechecks instance, epoch and credential **inside the `BEGIN IMMEDIATE` transaction**, so a write
  that was authenticated before a rotation is rejected at commit. Handles are invalid after
  rotation, `close` or reopen.
- **Local-only rotation.** `rotateAuthority` is for the operator process with direct state-file
  access; it must never be exposed over the worker control API. Epochs and credential hashes are
  never reused.
- **Generations.** Canonical decimal strings, at most `9223372036854775807`, compared as `BigInt`.
  A higher generation applies; the exact latest operation replays idempotently; everything else
  conflicts. A route at the maximum generation can never move again.
- **One hostname registry** for deployments, aliases and tombstones. Existing hostnames survive an
  apps-domain change; only new admissions use the current domain.
- **Fail closed.** Missing, replaced, unlinked, re-permissioned or unsupported state makes the
  store unavailable, and it stays unavailable until reopened.
  Lock contention (`SQLITE_BUSY`/`SQLITE_LOCKED`, e.g. an operator's `sqlite3` session) is the one
  transient case: that call reports unavailable and the store keeps working afterwards.
- **Retryable initialization.** A failed `initializeRouterState` removes the file it created; a stale
  `-wal`, `-shm` or `-journal` next to a new path is refused rather than adopted.

## Request handlers (R2a)

`createControlHandler(store)` (private control plane) and `createDataHandler(store, { upstream })`
(public data plane) are `(Request) => Promise<Response>` functions over one open store, and
`parseRouterHostConfig(env)` validates the settings. The rules (authentication before routing, fixed
bodies, Host canonicalization, header lists, timeouts, no rotation endpoint) are in the
[plan](../../docs/plans/production-alias-router.md#r2-design-host-split-in-two-increments); the tests
are their specification. `createHttpUpstream` is the real Node HTTP/HTTPS transport: `Host`, TLS server
name and certificate verification use the immutable deployment hostname, and verification is never
disabled. HTTP/1.1 only.

## Private control client (P4c)

The private `createRouterControlClient` registers a deployment, replaces an
alias route, and reads it back. It uses a deadline for the request and response
body, caps response size, refuses redirects, and checks instance and epoch on
route replies. Use an operator-configured URL on a private control network.
The client does not retry. `rejected` applies only to the current request; a
timeout, lost reply, conflict, or invalid reply leaves the outcome `uncertain`.
The worker must still read back and verify the route, including the registered
target hostname, and probe its identity before committing a promotion or
releasing any pins.

## Limits

Single-process by design (R2 must hold an exclusive process lock); SQLite durability relies on the
storage honoring `fsync`; restoring an old copy of the state file can resurrect an old epoch (the
restore procedure must establish a new epoch first). The error type never carries secrets.

## Tasks

`omni -i run check test build -p @launchpad-kit/alias-router`. Tests run under Bun
(`bun:sqlite`) against real SQLite files in temporary private directories; no Docker or network.
`omni -i run test:integration -p @launchpad-kit/alias-router` opens loopback listeners to exercise the
real HTTP/HTTPS transport and needs `openssl` on the PATH to generate throwaway test certificates.
