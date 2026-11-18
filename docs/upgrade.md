# Upgrade an installed controller and worker

For an instance operator upgrading from a previous schema. Migrations are
forward-only: **rollback means restoring the pre-upgrade backup**, not running a
down migration. Rehearse on disposable infrastructure first: the checked-in
14-migration fixture is exercised by `omni -i run test:upgrade -p @launchpad/controller`.

1. Record the current image versions and runtime settings, and arrange an
   outage. Turn deployments and lifecycle **off** in controller and workers;
   stop all workers and the controller, wait for them to exit and for any remote
   Dokku command to finish. The worker needs up to 25 minutes to stop; for a
   possible deletion, wait longer than the longest Dokku command **and** the
   five-minute deletion lease after it exits. See [restore](restore.md).
2. Take and verify a [pre-upgrade backup](backup.md) with the currently running
   version. Store the database dump and archives together, and keep the auth
   secret, environment settings, Dokku host state and preview datastores
   separately. Do not proceed if `verify-backup` fails.
3. Make the new controller image available **without starting the server or
   workers**. With the same database and migration files as that image, run
   `bun .output/admin.mjs migrate --status`. Pending migrations return exit 1;
   unknown migrations mean this image is **older** than the database: stop.
4. Run `bun .output/admin.mjs migrate` once from the new image. Run
   `migrate --status` again and require `pending: 0`, no unknown migrations,
   and exit 0. Do not run migrations from source if the installed image carries
   a different set.
5. Start the new controller with deployments and lifecycle still off, then the
   new workers as appropriate. Check the operator-only `GET /api/v1/status`
   for database and worker versions/heartbeat, then enable deployments and
   finally lifecycle when ready. `/api/health` alone does not check PostgreSQL.

If the migration fails or the new version cannot run, **do not** start the old
version against the migrated database. Stop processes, turn both switches off,
and follow [restore](restore.md) using the pre-upgrade backup and the old
version. The [automated drill](restore.md#repeat-the-disposable-drill) exercises
backup → built migration → controller restart → status → fresh restore, but
does not provision or modify Dokku.
