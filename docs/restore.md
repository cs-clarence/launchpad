# Restore Launchpad state without deleting live previews

For an instance operator restoring a **matched** database dump and archive
directory. This procedure includes the steps that `restore` cannot perform
or prove. `restore` never contacts Dokku. Back up the target database first.

1. Close **all management access** at the private ingress (including API-key
   access); keep it closed through restore and credential reconciliation.
   Set `LAUNCHPAD_DEPLOYMENTS=off` and `LAUNCHPAD_LIFECYCLE=off` for controller
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
4. With the normal ingress still closed, allow only a trusted operator
   maintenance connection to the restored controller. Before opening
   management access, compare restored API keys, organization memberships
   and roles with a trustworthy **external** record of changes since the
   backup. Revoke those keys again. For each membership removed since the
   backup, an **authorized organization member** (an owner for an admin or
   owner membership, or an admin for a deployer or viewer membership; an
   instance operator has no automatic
   membership, and a member cannot re-add themselves after removing their own
   membership) must use their authenticated session for
   `DELETE /api/v1/organizations/{orgId}/members/{userId}`. For each role
   reduction, **first** confirm the user's email is verified or the account
   was operator-provisioned. If neither holds, re-adding fails: remove the
   membership first (an existing member cannot be invited), then, only if
   invitations are enabled (SMTP and invitation enrollment), invite the
   address with the lower `role`. The user accepts the emailed link through
   a gateway rule that admits only that user while normal ingress stays
   closed. Until accepted they have **no** access; never leave the higher
   restored role in place to avoid this. Otherwise have that authorized member remove the membership and then use
   `POST /api/v1/organizations/{orgId}/members` with the user's email and
   lower `role` (there is no in-place role-change endpoint; re-adding
   deactivates the user's API keys, so reissue any that are still needed). Verify the
   resulting membership and role using
   `GET /api/v1/organizations/{orgId}/members` for **every** affected
   organization. The last owner cannot be removed; confirm another authorized
   owner first. Removing a membership deactivates its API keys, but does **not**
   block account sign-in. For a user who must lose all management access,
   use `bun .output/admin.mjs reset-password --email <address> --password-file
    <mode-600-file>` with a new undisclosed password (revokes sessions and
   keys), and deny that identity at the private access gateway. If email
   password recovery remains available to that user, a password reset alone
   is **not** a sign-in block: keep the gateway deny in force, or keep
   management ingress closed until a reliable block exists.
   If no complete and trustworthy key-revocation record is
   available, revoke **all restored API keys** via the authenticated
   `DELETE /api/v1/organizations/{orgId}/api-keys/{keyId}` endpoint (or
   follow the account-recovery procedure where appropriate), notify their owners, and
   reissue only the keys they still need after access is reopened. Review
   restored sessions and account changes made since the backup too; invalidate
   any sessions that should no longer be valid, including credentials for
   users removed since the backup. If membership/role changes cannot be
   reconstructed, validate **every restored membership and role** with
   organization owners and remove any unverified access before reopening;
   otherwise keep ingress closed. Do not assume deployments or
   lifecycle being off prevents authenticated reads. Confirm revocations
   before reopening the private ingress.
   Start the controller and workers with **deployments on but lifecycle still
   off**. Inspect deployments in `reconciliation-needed` for every preview
   you will keep; resolve each using the deployment resolution workflow
   (verify remote state, then mark it `succeeded` or `failed`; for a held
   deletion, choose `retry` or `deleted` only after checking Dokku) before enqueueing a new
   deployment. For each preview you will keep, redeploy its active artifact (this
   recreates a missing app), and **extend** any already-expired preview _before_
   turning lifecycle on. Check each deployment succeeds. Keep a record of
   previews intentionally ending.
5. Immediately before enabling lifecycle, recheck **every** preview you will
   keep for an expiry that has passed or may pass before cutover; extend it
   while lifecycle is still off. Do not rely on the step 3 expiry list.
   Turn lifecycle on in both controller and workers only after step 4. Delete
   the previews you chose to end and follow their deletion operations to a
   terminal state. Never manually delete a Dokku app just because it was
   absent in step 3. A restored database can also leave unreferenced apps;
   Launchpad deliberately leaves those alone.

## Repeat the disposable drill

For a contributor or operator rehearsing the database portion without live
Dokku: `omni -i run test:db:up`, then
`omni -i run test:upgrade -p @launchpad-kit/controller`, then
`omni -i run test:db:down`. Run the image drill on Linux (Docker host networking
does not reach the test database on Docker Desktop). This builds a temporary controller image and runs
the frozen previous-schema dump through backup, image migration, controller
start/restart from that image, an authenticated operator status read, and
restoration into another disposable database.
It creates only temporary test databases/directories and cleans them up.

The **remote** portion is a separate opt-in task, never run by CI:
`omni -i run test:restore:live -p @launchpad-kit/controller`. It requires
`LAUNCHPAD_LIVE_DOKKU=1`, the approved disposable Dokku at
`127.0.0.1:33022`, its test key and pinned host-key files under
`/tmp/opencode/live-dokku-20261117/`, and the disposable PostgreSQL at
`127.0.0.1:55432/postgres`. Start only those two test containers and pass
those settings with `omni -i -e .env.live-disposable-only`; the non-existent
env filename prevents a root `.env.local` from overriding the test host.
The test refuses any other host, port, key path, database or data mount.
This fixed path is a **maintainer-only** disposable environment, not a
portable install recipe; its provisioning and previous runs are recorded in
[live verification](plans/live-dokku-verification.md). It may need to be
recreated after a reboot.

In its **throwaway database only**, it substitutes an `lp-test-` name
constraint and a test-only Dokku allowlist. It backs up three deployed
previews, pauses the local destroy adapter, signals the worker to stop, then
issues the real Dokku destroy. It waits for that destroy and a shortened **one-second test lease**
to settle, restores the database and archives, finds two missing apps on
the real disposable Dokku, recreates and redeploys a missing kept preview, extends an expired
one before enabling lifecycle, and deletes the preview chosen to end.
Production validation is unchanged. The recorded run is in
[live verification](plans/live-dokku-verification.md#restore-runbook-rehearsal-2026-11-18).
The shortened lease and simulated worker stop do **not** measure the
production five-minute wait or prove what an arbitrary slow remote trigger
will do; follow step 1's full wait in a real incident. Never point this
task at `view-demo`, production PostgreSQL or a non-disposable Dokku.
If the task is interrupted or reports leftover names, inspect **only** the
approved disposable Dokku with its pinned SSH key:
`ssh -i /tmp/opencode/live-dokku-20261117/id_ed25519 -o UserKnownHostsFile=/tmp/opencode/live-dokku-20261117/known_hosts -o StrictHostKeyChecking=yes -p 33022 dokku@127.0.0.1 apps:list`.
The task prints a mode-`0600` resource log path under `/tmp/opencode/` before
creating resources; it records each exact database and app name. Confirm each
leftover is an `lp-test-` name recorded by this run, then destroy
it by **exact name**, one at a time (`ssh` with the same options, then
`apps:destroy <exact-lp-test-name>`). Do not bulk-delete matching apps and
never run a destroy against the normal Dokku or `view-demo`. The task creates
`lp_test_*` databases only in the disposable PostgreSQL; on an abrupt kill,
list them there and remove only the exact names this run recorded, after
confirming no test process is still connected.
