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
   (longer for slow destroy triggers). An enabled deployment worker needs its stop
   grace period (at least 30 seconds) and then a wait longer than one dispatch (290
   seconds) and the five-minute lease. An interrupted deployment step or app
   destroy comes back as `reconciliation-needed`; an interrupted image removal
   resumes on the next claim. Verify on the Dokku host that no
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
    the refusal. The flag confirms _all of step 1_. There is no worker heartbeat
    table or automatic proof that writers or remote operations stopped. Restore checks
    the manifest and dump before changing anything, restores archives first,
    then swaps the `public` schema. A failed restore rolls back a schema swap
    where possible; for an interrupted process, follow the recovery notes in
    [the controller reference](../apps/controller/README.md#restore) before
    starting anything. Run restore and recovery-clear as the controller's **OS
    user** (UID 10001 in the images), not root: owner-only maintenance files must
    remain accessible to that same user. The existing, shared `LAUNCHPAD_DATA_DIR` mount must be
    available: this binary writes an owner-only recovery marker after all refusals
    and archive pre-checks, before copying any archive. A failed or killed restore
    keeps that marker. A restored `ready` database row cannot bypass it.

3. If `restore` reports pending migrations, check whether 018 is pending **before
   running `migrate`**. If it is, keep ingress closed
   and first use the **pre-P2b binary** against the restored database for
   `inventory-previews --all`. Verify a matched backup and preserve Dokku state
   before any exact-name cleanup; follow the [cutover runbook](deployment-cutover.md)
   while the old table identities still exist. Never defer this inventory until
   after migrating. Then migrate from the **intended** version and run `migrate --status` (`pending: 0`, exit
   0). Run `bun .output/admin.mjs check-restore` with the `DOKKU_SSH_*` settings while workers are stopped. It records
   its lists of **missing archives, missing
   immutable deployment apps and passed deployment preview deadlines**. Queued
   jobs have not touched Dokku and are not probed. `--no-dokku` is only a partial check.
   Missing archives require repair before a deployment; an unreachable Dokku
   is an error, not a missing app. The check changes nothing.
4. Start the restored controller with normal ingress still closed. Use temporary
   access-gateway rules (or an equivalently restricted private maintenance path)
   that allowlist **identity, target organization, HTTP method and exact API path**.
   Verify the member's current authority for that organization against the external
   record before granting access, never against restored ownership alone.
   Before accepting **any** maintenance request from that member, require their
   restored membership and role in every organization allowed by the grant to
   match the verified current authority exactly. Method/path restrictions alone
   do not constrain a membership POST body: an admin whose restored row still
   says owner could otherwise grant ownership. Keep that identity blocked until
   an independently verified authorized member, whose own restored role already
   meets this rule, corrects the stale membership through the restricted path.
   If no such member is available, stop recovery with ingress closed; do not
   temporarily admit the stale actor to repair their own permissions.
   Allow only the reconciliation operations below for that organization and the minimal
   sign-in/session endpoints needed to authenticate. Block other organizations,
   dashboard/server-function routes and unrelated mutations, including for a member
   who is a restored owner elsewhere. Check denied requests cannot bypass these
   restrictions using alternate path encodings or ingress routes. Each member
   signs in with their own session to perform the membership changes below; the
   operator cannot act as that member.
   If the maintenance path cannot enforce these restrictions, do not admit the
   member until their stale permissions across all organizations have been removed
   by independently verified authorized members through a restricted path. If that
   cannot be arranged safely, keep management access closed and stop recovery here.
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
   ingress. Keep every worker stopped until recovery is cleared in step 6 (a worker
   with deployments off is harmless), then start enabled workers.
5. Migration 018 unconditionally drops preview-era data, including from an old
   restored backup; inventory/cleanup must use the pre-P2b binary first
   ([cutover runbook](deployment-cutover.md)). Never manually delete a Dokku app
   just because it was absent in step 3. A restored database can also leave
   unreferenced apps; Launchpad deliberately leaves those alone. The
   immutable model remains mutation-blocked until recovery is explicitly cleared.
6. Reconcile **before** clearing. With aliases in use, start the router again (rotation needs it
   stopped), keep every worker stopped, and run
   `bun .output/admin.mjs recovery-raise-counters`. It needs the router settings
   (`LAUNCHPAD_ALIAS_CONTROL_URL`, `LAUNCHPAD_ALIAS_INSTANCE_ID`, `LAUNCHPAD_APPS_DOMAIN`, the token and
   epoch files) in **the controller user's** environment, including its own copy of the token file
   (mode 0600, owned by that user), and reads the router through its control endpoint with the **new**
   epoch and token. It raises each alias's reserved
   generation to the router's generation for its hostname, never lowers one, and leaves the committed
   generation alone, so a restored database cannot hand out a generation the router has already
   seen. It lists any route the router serves for a hostname Launchpad has no alias for (for example an alias
   created and promoted after the backup): withdraw each with
   `recovery-withdraw-unknown --hostname <h> --i-have-verified-the-router-by-exact-route`, which writes a
   withdrawal at the next generation and never touches a known alias, or restore its alias. A withdrawn
   hostname stays reserved on the router for the old alias, so do not create a new alias with the same
   hostname. Then, as the controller's OS user, run
   `bun .output/admin.mjs recovery-clear --i-have-reconciled-router-and-dokku`. The flag is
   mandatory every time: the command never looks at the model tables or at
   `maintenance/model-writer-seen`, because a restore can replace the volume or bring an empty
   database that still has remote resources. By passing it you attest, in this order, that you
   (1) closed ingress and stopped every pre-restore writer **and waited for every Dokku operation
   they had dispatched to settle**, (2) stopped the router if used and
   [rotated its epoch and control credentials in managed mode](../apps/router/README.md)
   using `--database-url-file` (a 0600 file holding the target URL) after the restore command has exited, (3) reconciled
   Dokku apps (and, from P4, aliases) against the restored
   database, and (4) are clearing only now. The command now also compares the router: it refuses
   while any alias counter is below the router's generation, while the router serves a route
   Launchpad does not know (a route that serves nothing does not block), when the router cannot be
   read (the message says why), and when the database holds aliases but no router is configured. If the
   control URL is not set at all, no router is read: an installation that has ever used aliases must
   keep the router settings on the host that runs `recovery-clear`. Targets and Dokku are
   still your attestation; P5 replaces it with verified reconciliation ([recovery design](design/deployment-cutover-schema.md#restore-and-the-recovery-gate)).
   The command audits only the attested fact, commits the ready gate, then removes
   `maintenance/deployment-recovery-blocked` and fsyncs its directory. It still refuses while a
   crashed import is pending. Do not delete the marker or writer record by hand.
   Sign-in, organizations, members, projects and key administration remain available
   while the model is blocked; the marker is not an access-control substitute.

## Recover a crashed importer before retrying

Before spawning `pg_restore`, this binary fsyncs
`maintenance/deployment-import-in-progress`, identifying the target database and
the import's `PGAPPNAME`. A normal child exit is followed by a check that import
backends have disconnected before the record is removed. If the admin dies,
or backend exit cannot be established, the record remains. Another restore and
`recovery-clear` then refuse, even if the restored model is empty. No schema undo
is attempted while an importer might still commit.
Custom `LAUNCHPAD_PG_RESTORE` programs are trusted synchronous replacements:
they must `exec` the actual client or wait for it and all import workers, forward
`PGAPPNAME`, and never background or queue an importer that outlives the wrapper.
For remote/container wrappers this includes handling cancellation without leaving
an untracked later-connecting worker. An absent backend cannot make a fire-and-forget
wrapper safe; such wrappers are unsupported.

1. Keep ingress closed and preserve the backup and any `launchpad_replaced_*`
   schema. Inspect the owner-only import record, its database identity,
   application name and timestamp. Identify and stop the **exact** old importer
   and all wrappers; verify their OS processes have exited. A missing backend
   alone is not proof: a surviving wrapper may connect later. Do not kill a
   process solely from an old PID, which may have been reused.
2. On the recorded database, inspect `pg_stat_activity` for that application's
   backend and any other `pg_restore` or `launchpad-restore-*` importer. Confirm
   no earlier import backend remains or could commit. If you cannot establish
   both OS-process and database-backend exit, stop here.
3. As the controller's OS user, with the **same data directory and target database**:

    ```sh
    bun .output/admin.mjs recovery-ack-import --i-have-stopped-the-importer
    ```

    The flag attests to step 1 and backend exit. The command additionally refuses
    while an import backend is visible. It fsyncs a count-only acknowledgement in
    `maintenance/deployment-import-ack-<operation-id>` **outside the database dump**,
    then removes/fsyncs the pending record. The acknowledgement is durable even if
    `public` is empty or replaced by the next restore. It does **not** clear the
    model recovery marker.
    The audit records the operator's attestation/request before removal, not a claim
    that removal succeeded; if removal fails, the pending record continues to block.

4. Follow the interrupted-schema recovery notes in the
   [controller reference](../apps/controller/README.md#restore), then retry the
   verified restore procedure. Never remove import/recovery records manually
   or run `migrate` while an import could still be running.

## Repeat the disposable drill

For a contributor or operator rehearsing the database portion without live
Dokku: `omni -i run test:db:up`, then
`omni -i run test:upgrade -p @launchpad-kit/controller`, then
`omni -i run test:db:down`. Run the image drill on Linux (Docker host networking
does not reach the test database on Docker Desktop). This builds a temporary controller image and runs
the frozen previous-schema dump through backup, image migration, controller
start/restart from that image, an authenticated operator status read, and
restoration into another disposable database, plus a post-018 backup round trip.
It creates only temporary test databases/directories and cleans them up.

The opt-in remote rehearsal (`test:restore:live`) was removed with the preview runtime.
