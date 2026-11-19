# @launchpad-kit/alias-router

The durable, generation-checked routing authority for immutable-deployment aliases
(R1 of [the production router plan](../../docs/plans/production-alias-router.md)).
For contributors building the router host (R2) and the worker client. **Private, Bun-only,
not wired into the controller or worker, and not a production service on its own:** it has
no listener, no network surface and no startup path.

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

## Limits

Single-process by design (R2 must hold an exclusive process lock); SQLite durability relies on the
storage honoring `fsync`; restoring an old copy of the state file can resurrect an old epoch (the
restore procedure must establish a new epoch first). The error type never carries secrets.

## Tasks

`omni -i run check test build -p @launchpad-kit/alias-router`. Tests run under Bun
(`bun:sqlite`) against real SQLite files in temporary private directories; no Docker or network.
