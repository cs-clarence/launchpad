# Replace preview-era data with the immutable schema

For an operator preparing the P2b upgrade. Use this procedure only with a reviewed
P2b release after its schema/recovery gates pass; development test results are not
authorization to run it against an installation. See the [cutover plan](plans/deployment-p2-cutover.md).

Migration 018 unconditionally drops all preview, deployment, deployment-event,
deletion-operation and worker-heartbeat data. It keeps no history and reserves
none of their hostnames or Dokku app names. It does not contact Dokku. Afterward
the database cannot tell you which old apps need removal.

## Before migration 018

1. Close management ingress and stop every old controller, worker and writing
   admin job. Preserve the pre-cutover database and the operation list from stop
   time. Apply the [settling rule](design/deployment-cutover-schema.md#restore-and-the-recovery-gate):
   after the last writer stops, wait at least 25 minutes, check on the Dokku
   host for worker-started Docker/Dokku processes, and examine every target in
   the pre-stop pending-intent/unexpired-lease list by exact app name. A worker
   exit, expired lease or missing app alone does not prove dispatched work ended.
2. With the **pre-P2b binary**, take and verify a matched database/archive
   [backup](backup.md). Keep authentication secrets and Dokku state separately.
   Keep the old binary too: rollback after 018 is a restore of this backup with
   that binary, under closed ingress, not a down migration.
   Run file-writing admin commands as the controller's OS user (UID 10001 in
   the images), including restore/recovery-clear after migration, so owner-only
   maintenance files are usable by the controller and future workers.
3. Still using the pre-P2b binary, record the complete inventory:

    ```sh
    bun .output/admin.mjs inventory-previews --all
    ```

    `--all` includes deleted previews, whose destroy may have failed. A nonzero
    exit flags database state to inspect; it is not a migration refusal guard.
    The inventory changes nothing and cannot prove remote settlement.

4. Compare recorded app names with exact-name Dokku reads on the intended host.
   Remove only the explicitly identified old apps you do not intend to leave
   behind, recording each decision and result. Do not bulk-delete by prefix,
   prune volumes/images, or assume an unknown app belongs to this installation.
   Verify removal or explicitly record any intentionally retained orphan.
5. Only after the full P2b release passes its schema, recovery, image and upgrade
   gates, follow the [upgrade guide](upgrade.md) with the new binary. A lock timeout
   or unexpected dependent object aborts migration 018 transactionally; inspect
   the cause rather than adding `CASCADE` or disabling guards.

The immutable worker is not part of this upgrade. Deployment remains unavailable
until P3, and nothing in this procedure authorizes production startup, DNS changes
or connector changes.
