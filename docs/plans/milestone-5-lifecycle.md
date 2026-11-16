# Milestone 5: previews expire and recover predictably

Status: **approved by the user (2026-11-16)**: the default values, who may delete, deferring
runtime logs, and `--allow-delete` for the MCP tool. Extends `docs/plans/application.md`
milestone 5 and `docs/design/application.md` ("Lifecycle, storage and operations",
"Jobs, concurrency and reconciliation"). High risk.

## Assessment

- **Kind:** large (new tables and a second privileged job kind, destructive external
  side effects, a scheduler, file deletion, a new operator surface).
- **Risk:** High. This is the first code that **destroys** things: Dokku apps, Docker
  images and stored artifacts. The failure modes that matter are deleting something that
  is not ours or is still needed (a foreign app, a rollback artifact), racing a deploy or
  an extension, acting twice after a crash, and an ambiguous SSH result.
- **What already exists and is reused, not redone:** the lease/fencing pattern
  (`attempt` on every state write, write-ahead `step_pending`), one-unfinished-operation
  per preview as a database rule, `desired_state` (`active|deleting|deleted`), the Dokku
  adapter's allowlisted `apps:destroy`, `apps:exists`, the reconciliation/resolve pattern
  and `preview:resolve`, `recordAudit`, `resolveArtifactPath`, and the worker's fixed docker
  vocabulary.
- **Undo:** everything destructive ships **off** (`LAUNCHPAD_LIFECYCLE=off` by default, like
  `LAUNCHPAD_DEPLOYMENTS`). Turning it off stops the scheduler, deletion and cleanup and
  keeps all rows, artifacts and jobs for reconciliation. A deletion itself cannot be undone;
  what is kept is documented under "What deletion keeps".
- **Execution:** solo, one PR per slice; independent Opus review of the safety gate (slices
  2–4) and of the whole milestone, as for milestone 3.

## Outcome

A deployer chooses a lifetime for a preview, extends it, or deletes it; an expired preview
is deleted on schedule even after downtime; deleting and cleanup remove only what
Launchpad created and recorded, never anything else; a crash or a timeout at any step
is recovered or surfaced to an administrator without a second, blind destructive attempt;
and an operator can see whether the system is healthy and how far behind it is.

## Decisions to approve

1. **Lifetimes.** New previews get `expires_at = now + default TTL`, configurable:
   `LAUNCHPAD_DEFAULT_TTL` (proposal 7 days) and `LAUNCHPAD_MAX_TTL` (proposal 30 days).
   `deploy --ttl 24h` (and the API's `ttl`) may choose any value up to the maximum.
   "Never expires" is refused unless an operator sets `LAUNCHPAD_ALLOW_NO_EXPIRY=on`.
   Previews that exist today have no expiry (`null` = never) until extended or given one;
   a later operator command can apply the default to them (not built here).
2. **Extension.** `POST …/previews/:id/extend {ttl}` computes, with `clock` sampled **after
   the preview row lock is acquired** (`clock_timestamp()`, not the transaction's `now()`,
   so a long lock wait cannot make the result already past):
   `expires_at = greatest(expires_at, least(greatest(clock, expires_at) + ttl, clock + max TTL))`.
   An extension therefore never shortens a lifetime: if the cap (for instance a maximum an
   operator lowered since) would reduce the existing expiry, the existing expiry is kept and
   the response reports it. Each requested `ttl` must be positive (zero and negative are
   refused) and at most the maximum. It succeeds only while the preview is `active`; once
   expiry has claimed it, extension is a conflict (see the race rule below).
3. **Who may delete.** New permission `preview:delete` for deployer, admin and owner,
   as for deploy; keys may be granted it. Expiry has no actor (recorded as `system`).
4. **Deletion semantics.** A deletion is an **operation** (a row, like a deployment): the
   request flips the preview to `deleting` and queues the operation in one transaction;
   nothing waits on Dokku inside an HTTP request. Order: (a) refuse new deployments and
   cancel queued ones (they were never started), (b) wait for a running deployment to reach
   a terminal state (bounded by its lease; no mid-step cancellation is introduced), (c)
   destroy the Dokku app, (d) remove the worker's images for this preview, (e) mark the
   preview `deleted`. The preview's rows, deployments and events stay (audit); only the app,
   images and, after retention, artifacts go.
5. **Ownership rule for destruction.** The only app ever destroyed is the `app_name` of a
   preview row Launchpad created, matching `^lp-[a-z0-9]{10}$`, re-read inside the fenced
   step. Apps that merely exist on the host are never imported, listed for deletion or swept;
   a read-only report may list `lp-*` apps with no row, and does nothing about them.
   Images are removed only by exact tag recorded on this preview's deployments. **No
   `docker system prune`/`image prune`, no volume or database removal exists in the
   vocabulary**, and a test asserts the adapter and the docker wrapper expose none.
6. **Ambiguous outcome.** `apps:destroy` of an owned app is idempotent in effect, unlike an
   image load, so after an uncertain result the next attempt first asks `apps:exists`: absent
   means done, present means destroy again. Attempts are bounded; past the bound the
   operation is `reconciliation-needed` for an administrator (`preview:resolve`, the same
   audited pattern as deployments).
7. **Artifact retention.** An artifact is collected only when no deployment of an `active`
   preview references it (so rollback keeps its stored archive) and
   `LAUNCHPAD_ARTIFACT_RETENTION` (proposal 7 days) has passed since the preview was deleted
   or, for an upload nobody deployed, since it was stored. The database row is removed
   first, then the file; a file with no row is an orphan swept after the same retention (a
   row with no file would break rollback, so that order is never reversed). This also relieves
   the per-organization artifact ceiling that nothing frees today.
8. **Runtime logs.** A static Nginx preview writes nothing useful, deployment progress
   is already in the events, and the controller must not reach Dokku. Proposal: **defer**
   `GET …/logs` (the design lists it, the milestone mentions it) and say so in the docs. If
   you want it now, it needs a worker-mediated request/response table; say so and I will
   plan it as its own slice.
9. **Operator status.** A worker heartbeat row (written each poll), and an operator-only
   `GET /api/v1/status` with dependency readiness (database, data directory), worker
   heartbeat age, deployment backlog and oldest age, overdue expiries, pending deletions,
   and artifact count/bytes. API only for now; a dashboard panel can follow.
10. **MCP.** A `delete_preview` tool, only with a new startup flag `--allow-delete`
    (separate from `--allow-deploy`), `confirm: true`, the same project allow-list by id, and
    resource ids not names, as the design requires.

## The race rules (what the tests must prove)

- **Expiry vs extension:** expiry claims a row with `FOR UPDATE SKIP LOCKED` where
  `expires_at <= now() and desired_state = 'active'` and, in the same transaction, sets
  `deleting` and inserts the operation. Extension takes the same row lock. Exactly one
  wins; the loser sees the other's result (extension after claim is a 409; an extension
  that committed first moves `expires_at` past `now()`, so expiry no longer matches).
- **Deploy vs delete:** `enqueueDeployment` already refuses a non-`active` preview; the
  deletion transaction cancels queued deployments under the same preview lock, so a
  deployment queued before the delete cannot start after it. A deployment already running
  finishes (or fails) before the destroy step begins; the operation does not start while one
  is unfinished.
- **Deleted cannot be revived:** nothing sets `deleted` back to `active`; a stale worker's
  write is refused by the `attempt` fence.
- **Stale worker:** the operation has a lease and an `attempt` fence exactly as a
  deployment; a worker that lost its lease cannot write, and its Dokku calls are bounded by
  a lease-derived deadline.
- **Downtime:** after any outage the scheduler claims every overdue preview in bounded
  batches; nothing is lost, and none is claimed twice.

## Slices (one PR each)

1. **Data model and permissions.** Migration: `preview.expires_at`, `deleted_at`,
   `deletion_operation` (kind-specific columns, lease, `attempt`, `step_done/pending`,
   one unfinished per preview), `worker_heartbeat`; `preview:delete`; audit action names;
   TTL configuration loader with validation (default ≤ max, positive, bounded).
2. **Expiry and extension (services).** `ttl` on create, `extendPreview`, the scheduler
   claim, all race tests above against PostgreSQL.
3. **Deletion operation (services).** `requestDeletion` (idempotent, audited),
   claim/run with injected `LifecyclePorts` (like `DeployPorts`), fencing, write-ahead steps,
   ambiguous-outcome handling and resolve. Fake-port tests for every crash and timeout
   point, stale worker and a foreign app name.
4. **Worker ports and cleanup.** Real ports (`apps:exists`/`apps:destroy` through the existing
   adapter, exact-tag `docker image rm`), artifact collection and the orphan sweep, scheduler
   loop in the worker (off unless `LAUNCHPAD_LIFECYCLE=on`), extension of the opt-in live
   task (destroy a disposable app and verify a neighbour app is untouched). The ownership pattern
   is an argument of the ports: production fixes it to `^lp-[a-z0-9]{10}$` (it is not
   configurable from the environment), and only the live test passes a separate, guarded
   `^lp-test-[a-z0-9]{6}$` one, as the milestone 3 live task already does. **Opus review
   of slices 2–4 before continuing.**
5. **API, SDK, CLI, dashboard.** `DELETE` and `extend` routes (idempotency keys, 202, scopes,
   project-limited keys through the owning project), `expiresAt` on previews, SDK, client
   core, `previews delete|extend` and `deploy --ttl`, dashboard expiry display and
   role-aware buttons.
6. **Status.** Heartbeat writes, `GET /api/v1/status` (operator only), docs.
7. **MCP.** `delete_preview` behind `--allow-delete`; e2e through the built binary.
8. **Milestone Opus review** and fixes.

## Verify

Concurrent deploy/delete/extend (PostgreSQL); expiry after downtime; a crash and an SSH
timeout at each destroy step, including success-then-timeout; a stale worker; the database
unavailable during a lease (the worker stops, nothing is destroyed twice); foreign and
orphan apps untouched; an artifact still needed for rollback never collected; a test that
no prune, volume or database command exists. Live: only with a disposable Dokku the user
starts, `lp-test-` prefix, never CI, never touching `view-demo`.

## Not in this milestone

Runtime logs (unless approved above), restoring a deleted preview, backup/restore
(milestone 6), applying a default expiry to existing previews, custom domains, a dashboard
operator panel.

## What deletion keeps

The preview row and its deployments, events and audit records stay (hostnames are not reused:
`app_name` and `hostname` are unique). The Dokku app is gone and its images are removed (if an image cannot be removed the deletion still finishes and records `images-left-behind`, so an operator should not assume none remain); artifacts are
kept for the retention period and then collected, so within that window a deleted preview's
content could be re-published by hand from storage, and after it nothing can.

## Progress

- Slice 1 (data model and permissions): migration `20261116_013_preview_lifecycle`
  (`expires_at`, `deleted_at` with a check tying it to the deleted state, an expiry index,
  `deletion_operation` with the fenced lease columns and one unfinished per preview,
  `worker_heartbeat`), `preview:delete` (deployer and above, and a key scope), `parseDuration`,
  and the lifecycle configuration loader with its audit action names. No behavior changes: the
  new columns are unused and the settings are not read by anything yet.
- Slice 2 (expiry and extension, services): new previews get an expiry (`ttl` on create, the
  default otherwise, `none` only where allowed; part of the idempotent request); `extendPreview`
  with the approved formula (clock read after the row lock, never shortens, capped from now,
  positive only, `preview:deploy`, idempotent); `queueDeletion` (shared with manual deletion in
  the next slice: flips the preview to `deleting`, cancels queued deployments, queues the
  operation in one commit); `expirePreviews` (bounded batches, `FOR UPDATE SKIP LOCKED`,
  re-checked under the lock). `expiresAt` is now on the preview contract. Races are tested
  against PostgreSQL: expiry vs extension on 24 previews at once (exactly one wins each),
  concurrent sweeps, a long lock wait, an outage worked off in batches. The scheduler loop is
  slice 4; nothing destroys anything yet.
- Slice 3 (deletion operation, services): `requestPreviewDeletion` (`preview:delete`, membership
  re-read after the lock, a repeat returns the queued operation), `claimDeletion` (leases, the
  attempt fence, waits for a running deployment, bounded attempts), `runDeletion` with injected
  `LifecyclePorts` (write-ahead `destroy` then `images`; asks `apps:exists` before any destroy, so a
  lost answer after a destroy that worked is recovered without a second one (if the app is still
  there, destroy is tried again, within the bounded attempts); refused calls and exhausted attempts are
  held for a person; leftover images never block the deletion), the ownership pattern as an
  argument (`OWNED_APP_PATTERN`, nothing sent to Dokku for any other name), and
  `resolveDeletion` (`preview:resolve`: `deleted` or `retry`). Fake-host tests cover every crash
  and timeout point, a stale worker, a worker past its lease deadline, shutdown, expiry feeding
  the same path, and deploy vs delete on 20 previews at once; mutation checks confirmed the
  ownership check, the existence check, the wait for deployments and the fence each fail a test
  when removed. The real ports and the scheduler loop are slice 4.
- Slice 4 (worker ports and cleanup): the real ports (`lifecycle-ports.ts`: exists, destroy and
  exact-tag `docker rmi`, nothing else; the Dokku client's own name pattern is the second guard),
  `runLifecycleOnce` in the services (expiry claim, at most one deletion, periodic collection) called
  by the worker between deployments and off unless `LAUNCHPAD_LIFECYCLE=on`, artifact collection
  (`collected_at` tombstone, migration `…_015`; eligibility: retention, no deployment of a
  non-deleted preview, none unfinished, none deleted within the retention; share lock in
  `enqueueDeployment` against the collector; re-upload restores the archive) and the orphan file
  sweep, a test that reads the sources and fails on any prune/volume/network/database verb or an
  unlisted Dokku operation, and a live test of destroy against a neighbour app (written, **not
  run**: it needs a disposable Dokku). Mutation checks: live-preview protection, retention, and the
  share lock each fail a test when removed. The Opus review of slices 2-4 follows.
- Opus review fixes (slices 2-4): no safety blockers. Fixed: a name is free again once its preview
  is deleted (partial unique index, migration `…_016`); a one-time 24 h grace the first time the
  lifecycle is switched on (marker in `instance_state`); deletion refused while the lifecycle is
  off; an unreachable host no longer uses up the attempts and retries back off exponentially;
  deletion waits an hour after a deployment was held for reconciliation; a reused upload restarts
  its clock; retention at least 1h; a lifecycle round at least every 30 s; the collector takes the
  owner lock and skips a malformed key; the sweep skips symlinked owner directories. Documented
  only: one database per Dokku host and per data directory.
