# Restore Launchpad state without deleting live previews

For an instance operator restoring a **matched** database dump and archive
directory. This procedure includes the steps that `restore` cannot perform
or prove. `restore` never contacts Dokku. Back up the target database first.

1. Set `LAUNCHPAD_DEPLOYMENTS=off` and `LAUNCHPAD_LIFECYCLE=off` for controller
   **and** every worker. Stop all workers and the controller and wait for their
   processes to exit. Give workers a 25-minute stop grace period; **after** the
   last worker exits, wait longer than the longest possible remote Dokku command
   and the deletion lease (five minutes by default; more for slow destroy
   triggers). An SSH client exiting or an app disappearing does not prove the
   remote destroy settled. Make sure no other installation shares this Dokku
   host and data directory.
2. Verify the directory, then restore into an **empty** database owned by the
   runtime role using the same `LAUNCHPAD_DATA_DIR`, `DATABASE_URL` and
   `pg_restore` (or `LAUNCHPAD_PG_RESTORE`) as the installation:

    ```sh
    bun .output/admin.mjs verify-backup /private/backups/launchpad-2026-11-18
    bun .output/admin.mjs restore /private/backups/launchpad-2026-11-18 --i-have-stopped-the-workers
    ```

    For a populated target, first back it up, then add
    `--replace <host:port/database>` with **exactly** the address printed by
    the refusal. The flag confirms _all of step 1_, not just an expired
    heartbeat; the command separately refuses recent heartbeats. It checks
    the manifest and dump before changing anything, restores archives first,
    then swaps the `public` schema. A failed restore rolls back a schema swap
    where possible; for an interrupted process, follow the recovery notes in
    [the controller reference](../apps/controller/README.md#restore) before
    starting anything.

3. If `restore` reports pending migrations, run `bun .output/admin.mjs migrate`
   from the **intended** version, then `migrate --status` (`pending: 0`, exit
   0). Run `bun .output/admin.mjs check-restore` with the worker's
   `DOKKU_SSH_*` settings and record its lists of **missing archives, missing
   apps and expired previews**. `--no-dokku` is only a partial check.
   Missing archives require repair before a deployment; an unreachable Dokku
   is an error, not a missing app. The check changes nothing.
4. Start the controller and workers with **deployments on but lifecycle still
   off**. For each preview you will keep, redeploy its active artifact (this
   recreates a missing app), and **extend** any already-expired preview _before_
   turning lifecycle on. Check each deployment succeeds. Keep a record of
   previews intentionally ending.
5. Turn lifecycle on in both controller and workers only after step 4. Delete
   the previews you chose to end and follow their deletion operations to a
   terminal state. Never manually delete a Dokku app just because it was
   absent in step 3. A restored database can also leave unreferenced apps;
   Launchpad deliberately leaves those alone.

## Repeat the disposable drill

For a contributor or operator rehearsing the database portion without live
Dokku: `omni -i run test:db:up`, then
`omni -i run test:upgrade -p @launchpad/controller`, then
`omni -i run test:db:down`. This builds a temporary controller image and runs
the frozen previous-schema dump through backup, image migration, controller
start/restart and schema status, and restoration into another disposable database.
It creates only temporary test databases/directories and cleans them up.

The **remote** portion cannot be simulated by that test. For a full rehearsal,
use only an isolated disposable Dokku and `lp-test-` apps: take a backup with
test previews and an already-expiring preview, start a deletion, stop workers
as in step 1, and observe the remote destroy settling **before** restoring.
Run steps 2–5 against that isolated host, record which app `check-restore`
listed as missing, redeploy one kept preview, extend the expired preview
before enabling lifecycle, and verify it survives while the preview chosen
to end is deleted. Never point this drill at an existing production Dokku,
`view-demo`, or real preview data. A simulated `apps:exists` check in the
admin integration tests covers detection; it cannot prove a remote destroy
has settled.
