# Restore Launchpad state

For an instance operator restoring a **matched** database dump and archive
directory. This procedure includes the steps that `restore` cannot perform
or prove. `restore` never contacts Dokku. Back up the target database first.

1. Close **all management access** at the private ingress (including API-key
   access); keep it closed through restore and credential reconciliation.
   Stop all workers, the controller and every admin job that can write to the
   target database, and wait for their processes to exit. Give any legacy worker
   its full 25-minute stop grace period. Wait for every Dokku operation it
   dispatched to settle; after the last legacy worker exits, wait longer than
   the longest possible remote Dokku command and the five-minute deletion lease
   (longer for slow destroy triggers). Verify on the Dokku host that no
   worker-started Docker/Dokku process remains. An SSH client exiting or an app
   disappearing is not proof of settlement. Make sure no other installation shares this Dokku
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
    the refusal. The flag confirms _all of step 1_. On a populated target,
    restore also refuses a worker heartbeat within the last minute, even with
    the flag; that check cannot prove that admin jobs or remote operations stopped. It checks
    the manifest and dump before changing anything, restores archives first,
    then swaps the `public` schema. A failed restore rolls back a schema swap
    where possible; for an interrupted process, follow the recovery notes in
    [the controller reference](../apps/controller/README.md#restore) before
    starting anything.

3. If `restore` reports pending migrations, run `bun .output/admin.mjs migrate`
   from the **intended** version, then `migrate --status` (`pending: 0`, exit
   0). Run `bun .output/admin.mjs check-restore` with the `DOKKU_SSH_*` settings (the worker is idle and does not read them; these are only for this check). It records
   its lists of **missing archives, missing
   apps and expired previews**. `--no-dokku` is only a partial check.
   Missing archives require repair before a deployment; an unreachable Dokku
   is an error, not a missing app. The check changes nothing.
4. Start the restored controller with normal ingress still closed. Use temporary,
   identity-specific access-gateway rules (or an equivalently restricted private
   maintenance path) for the trusted operator and only the authorized organization
   members needed for reconciliation. Each member signs in with their own session
   to perform the membership changes below; the operator cannot act as that member.
   Admit an invitee only for the acceptance step described below. Do not admit
   other restored identities or API-key traffic. Remove these temporary grants
   after reconciliation and retain any required identity denies before reopening
   normal ingress. Before opening
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
   otherwise keep ingress closed. Do not assume that stopped workers prevent
   authenticated reads. Confirm revocations before reopening the private
   ingress. Then start the idle worker if needed.
5. Restored preview data is inert: the preview runtime was removed, so nothing
   redeploys, extends or deletes previews. Never manually delete a Dokku app
   just because it was absent in step 3. A restored database can also leave
   unreferenced apps; Launchpad deliberately leaves those alone. The
   immutable-model migration will handle the old tables; see
   [the cutover plan](plans/immutable-p2-cutover.md).

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

The opt-in remote rehearsal (`test:restore:live`) was removed with the preview runtime.
