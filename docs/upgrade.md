# Upgrade an installed controller and worker

For an instance operator upgrading from a previous schema. Migrations are
forward-only: **rollback means restoring the pre-upgrade backup**, not running a
down migration. v1 starts with an empty database. Rehearse later upgrades on disposable infrastructure first.

1. Record the current image versions and runtime settings, and arrange an
   outage. Stop all workers and the controller and wait for them to exit. A worker with
   deployments off stops at once; an enabled worker needs its stop grace period (at least 30 seconds),
   then the same settlement wait as [restore, step 1](restore.md): longer than one
   290-second dispatch and the five-minute lease, and no worker-started Docker or
   Dokku process left on the Dokku host. An interrupted effect may be unconfirmed, but its
   status changes only when a worker next claims it after its lease lapses. After the
   upgraded worker has restarted, look for `reconciliation-needed` deployments, and for held deletions
   (`deployment_deletion_operation.status = 'reconciliation-needed'`; an event is history, so do not
   rely on it), and use `deployment-reconcile`; it records an observation and never calls Dokku.
   One lookup is not enough: a worker claims the oldest runnable work first and finishes each
   deployment before the next, so interrupted work that is newer than queued work is claimed
   later. Repeat the lookup until no deployment is `queued`, `preparing`, `building`, `deploying`
   or `verifying` **and** no deletion operation is `queued` or `running`, then look once more
   after both checks read zero (nothing runnable is left to move into a hold) and reconcile
   anything it returns. Repeat the whole check after reconciling, since reconciling a deletion
   lets the worker continue it. Never retry by hand.

2. Take and verify a [pre-upgrade backup](backup.md) with the current version.
   Keep the dump and archives together; preserve Dokku state, router state, settings
   and credentials separately.

3. Make the new controller image available **without starting the server or
   workers**. With the same database and migration files as that image, run
   `bun .output/admin.mjs migrate --status`. Pending migrations return exit 1;
   unknown migrations mean this image and database are incompatible: stop.
4. Run `bun .output/admin.mjs migrate` once from the new image. Run
   `migrate --status` again and require `pending: 0`, no unknown migrations,
   and exit 0. Do not run migrations from source if the installed image carries
   a different set.
5. Verify the shared `LAUNCHPAD_DATA_DIR` directory is mounted and available
   (missing storage is a startup error). Start the new controller, then the worker. Check the operator-only
   `GET /api/v1/status` for database readiness and, if `LAUNCHPAD_DEPLOYMENTS` is on, that `workers.state` is `ok` (with deployments off it is `off`). `/api/health` is liveness and
   does not check PostgreSQL; `/api/ready` does (see [production Compose](production-compose.md#health-readiness-and-worker-status)).

### This release adds migrations

`20261126_002_worker_heartbeat` creates one table, `worker_heartbeat`, and `20261128_003_app_settings`
creates one table, `app_setting`, with a function and trigger that keep its `updated_at` current. All
of it is additive (nothing existing changes)
and forward-only: **rolling back means restoring the pre-upgrade backup** with a compatible build, as below. An
older build refuses the migrated database (`503 schema-mismatch`, and `restore` refuses a backup taken after the
migration), so nothing runs half-rolled-back. Recreate the controller and worker **together**: an old worker
beside the new controller never beats, so status reports no worker and warns; a new worker started before
`migrate` logs one heartbeat error and keeps claiming.

Behavior changes to expect: a failing database re-check now answers `503` until it passes again
(`LAUNCHPAD_SCHEMA_CHECK_INTERVAL=off` restores the old check-once behavior); `GET /api/ready` and the
`schema-mismatch` and `database-unavailable` error codes are new; the controller's database pool waits at most 5 s
for a connection; and `lease_owner` is now the worker's name (hostname-derived by default) instead of a random
uuid per process. `LAUNCHPAD_WORKER_ID` still works but is deprecated: use `LAUNCHPAD_WORKER_NAME`.

If migration fails, do not start the old version against the migrated database.
Restore its matched backup into a fresh empty database using a compatible build
and follow the full [restore gates](restore.md).

## Aliases and verified recovery

Alias promotion is off by default and changes nothing until you set `LAUNCHPAD_ALIASES=on` on the
controller and the worker (the worker then needs the router settings, see [install](install.md)).
`recovery-clear` reads the router whenever the router settings
(`LAUNCHPAD_ALIAS_CONTROL_URL` and the rest) are configured for it, and refuses if the database holds any
alias but none are configured, so an installation that has created aliases must keep the router settings on
the host that runs `recovery-clear`. The command also needs pinned Dokku settings and the
restored archive directory. **Rolling back by restoring the pre-upgrade backup removes every promotion, withdrawal and alias
created after that backup**: they are absent from the restored database, not queued or pinned, and
the router may already serve them. Treat that as a restore: follow [restore](restore.md), including
counter repair, withdrawal of unknown routes, and exact alias republish as needed before
`recovery-clear`. Re-request any
promotion you still want. Rolling back the binary without restoring leaves queued promotions
unprocessed and their targets pinned, and reconciling is the same procedure as for a held operation.
