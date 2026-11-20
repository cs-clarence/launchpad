# Upgrade an installed controller and worker

For an instance operator upgrading from a previous schema. Migrations are
forward-only: **rollback means restoring the pre-upgrade backup**, not running a
down migration. Rehearse on disposable infrastructure first: the checked-in
14-migration fixture is exercised by `omni -i run test:upgrade -p @launchpad-kit/controller`.

1. Record the current image versions and runtime settings, and arrange an
   outage. Stop all workers and the controller and wait for them to exit. A worker with
   deployments off stops at once; an enabled worker needs its stop grace period (at least 30 seconds),
   then the same settlement wait as [restore, step 1](restore.md): longer than one
   290-second dispatch and the five-minute lease, and no worker-started Docker or
   Dokku process left on the Dokku host. An interrupted effect may be unconfirmed, but its
   status changes only when a worker next claims it after its lease lapses. After the
   upgraded worker has restarted and had time to claim (a few minutes), look for
   `reconciliation-needed` deployments (and `deletion-reconciliation-needed` events) and use
   `deployment-reconcile`; it records an observation and never calls Dokku. Never retry by hand. For a pre-P2a worker, complete the legacy worker
   grace-period and dispatched Dokku operation settlement checks in
   [restore, step 1](restore.md) **before taking the backup**. A worker exiting
   does not prove that its remote destroy finished.
2. Take and verify a [pre-upgrade backup](backup.md) with the currently running
   version. Store the database dump and archives together, and keep the auth
   secret, environment settings, Dokku host state and preview datastores
   separately. When upgrading from pre-P2a, run the old admin build's backup
   command after the confirmed stop and settlement in step 1:

    ```sh
    bun .output/admin.mjs backup /private/backups/launchpad-pre-p2a --i-have-stopped-the-workers
    bun .output/admin.mjs verify-backup /private/backups/launchpad-pre-p2a
    ```

    This flag belongs to the **old** backup command; P2a's backup command no
    longer accepts it. Do not proceed if `verify-backup` fails.
    **After** verifying the backup and preserving Dokku state, an upgrade crossing
    018 must complete the [pre-P2b inventory and exact-name app cleanup](deployment-cutover.md).
    Finish this before step 4: the old identities are dropped unconditionally.
    With all legacy upload writers stopped, inspect the actual data directory's
    `tmp/` directory for regular files named `upload-<24 lowercase hex characters>.part`.
    Record and remove only those exact abandoned staging files, one at a time;
    never remove finalized files under `artifacts/`, other temporary names or symlinks.
    The new controller no longer sweeps upload staging files at startup.

3. Make the new controller image available **without starting the server or
   workers**. With the same database and migration files as that image, run
   `bun .output/admin.mjs migrate --status`. Pending migrations return exit 1;
   unknown migrations mean this image is **older** than the database: stop.
4. Run `bun .output/admin.mjs migrate` once from the new image. Run
   `migrate --status` again and require `pending: 0`, no unknown migrations,
   and exit 0. Do not run migrations from source if the installed image carries
   a different set.
5. Verify the shared `LAUNCHPAD_DATA_DIR` directory is mounted and available
   (missing storage is a startup error). Start the new controller, then the worker. Check the operator-only
   `GET /api/v1/status` for database readiness. `/api/health` alone does not check PostgreSQL.

If the migration fails or the new version cannot run, **do not** start the old
version against the migrated database. Stop processes
and follow [restore](restore.md) using the pre-upgrade backup and the old
version. A restore performed by a binary that knows 018 also writes an external
recovery marker, even for a pre-018 dump; follow its recovery-clear procedure
before allowing model mutations. Prefer restoring into a **fresh empty database**, verify the restored
state with the old admin build, then point the old controller and workers at
that database. The old admin cannot back up a database containing migrations
it does not know. If an in-place `--replace` is unavoidable, first back up
the migrated target using the **new** admin build before replacing it; never
bypass the target-backup requirement. The [automated drill](restore.md#repeat-the-disposable-drill) exercises
backup → built migration → controller restart → status → fresh restore, but
does not provision or modify Dokku.
