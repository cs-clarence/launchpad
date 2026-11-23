# Fresh-host recovery rehearsal

For operators and maintainers preparing production recovery. This is a
high-risk drill, not a cutover or a production recovery-time claim. A clean
target passed; see [the result](#result-2026-11-23).
The [same-host drill](production-state-backup-rehearsal.md) recovered Dokku and
router storage but reused the original engine's images, app containers and
network. This drill must start with a clean target engine and recreate those
dependencies from the recovery set.

## Prerequisites and boundaries

- Use two disposable Linux Docker engines, preferably two dedicated VMs with
  no production mounts, Docker credentials, DNS or ingress. The worker and
  Dokku socket access is root-equivalent **inside the selected fixture VM**.
  Never mount an installed host's socket into either VM.
- Identify the source and clean target by engine ID; record the IDs and refuse
  to proceed if they are equal. Use distinct project IDs, loopback ingress and
  fixture-only keys. Do not join an existing apps network. Require a comparable
  CPU architecture, pinned images, and enough temporary disk for the image
  archive, both state copies and the restored data.
- Choose the operator-owned private transfer location and deletion/retention
  policy before creating the backup. Record resource names and ownership before
  creation. Do not put credentials or a backup archive in Git, task logs, or the
  public evidence bundle. Starting the VMs requires separate approval.

## Recovery set

| Artifact                         | Capture and validation                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database and deployment archives | Stop and settle writers; run the matching admin image's `backup` and `verify-backup`. Keep the source data intact.                                                                                                                                                                                                                                                     |
| Dokku and router state           | Stop both authorities and archive their storage offline with numeric owner and permissions. Save checksums. The Dokku archive contains SSH host keys; the router backup contains the routing authority state.                                                                                                                                                          |
| Images                           | Save the Compose images and the exact per-deployment references used by Dokku and the worker. Record tag-to-image-ID mappings. Verify the transfer checksums and loaded IDs; do not silently substitute a registry pull, cached tag or rebuild.                                                                                                                        |
| Configuration and secrets        | Keep exact versions, Compose inputs, apps network name and Dokku `initial-network`, volume ownership, worker SSH key and pinned host key, controller auth secret, database credentials, and router TLS and control credentials. Transfer secrets separately from public inventory. Declare any fixtures not covered (plugin state, app volumes, or external services). |
| Expected state                   | Record migration status, app names, deployment IDs, both served identities, alias route and generation, and router epoch. Use fingerprints, not private keys or tokens, in the test record.                                                                                                                                                                            |

## Worked rehearsal and pass gate

1. Start the source fixture and serve deployments A and B. Bind and promote
   one alias to B. Record both data planes and authenticated router readback.
   Quiesce all writers, verify Dokku settlement, capture the recovery set, and
   keep the source stopped so it cannot become a second authority.
2. On the target, capture the initial inventory and prove that no source
   image tags, app containers, network or state exist. Transfer and verify
   the recovery set. Load only the recorded images, create the isolated apps
   network and fresh storage, and restore the numeric ownership. Recreate
   network settings from the manifest, not from Docker's internal data
   directory. Refuse to continue on any incomplete transfer or mismatched ID.
3. Restore the approved database and archives with the matching admin image
   and explicit migration verification. Start the router and Dokku from their
   restored state, with writers still stopped. Prove how the fixture Dokku
   apps are recreated from inventoried images and state on an empty engine.
   Dokku can report healthy while it creates app containers in the background.
   Wait a bounded period for each final app container and for both deployment
   URLs and the alias to serve the expected `X-Launchpad-Deployment` values.
   A temporary `.upcoming-*` container does not count. If any identity fails
   to become reachable before the deadline, stop and record the gap;
   a separately reviewed, exact, idempotent reconstruction procedure must
   pass before claiming host-loss recovery.
4. Check the pinned SSH identity and control TLS, app inventory, routes and
   served deployment identities. Start only the restored controller and verify
   it rejects mutations. Follow the full [restore gates](../restore.md):
   verify the epoch anchor, rotate authority as required, raise counters,
   wait out the recovery window, and reopen writes only after `recovery-clear`
   succeeds. No shortened wait and no second router or Dokku authority.
5. Resume the target worker. Promote to A at a higher generation, verify
   deployment and alias identities, withdraw to a verified 404, and delete
   the fixture deployments. Record elapsed time, copy sizes, setup steps and
   every manual action. Do not claim a production recovery-time target from
   this fixture.

If any gate fails, keep writers and ingress stopped and preserve both copies
and all inventories. Do not restart a source authority while the target is
active. For cleanup, verify each engine ID, ownership and app settlement again;
remove only explicitly recorded fixture resources. Keep sanitized evidence
and verify the private fixture transfer is removed or retained according to
the agreed policy. The plan and results must be reviewed before any production
recovery procedure relies on them.

## Repeat the rehearsal

Use the [Compose startup procedure](../production-compose.md#first-start-in-order)
to make the source fixture, the [backup guide](../backup.md) for the matched
database and deployment archives, and the [restore runbook](../restore.md) for
database import, credential revocation and the write gate. The normal
`test:compose:rehearsal` task deletes its deployments and tears the fixture down;
it is not a fresh-host runner. Keep the source offline after capturing the set.

- **Prove both engine identities.** Record `docker info --format '{{.ID}}'` on
  each guest and refuse equal IDs. A golden image on which Docker already ran can
  carry the same engine ID into both clones. Prepare or reset identity only on
  a disposable, empty guest, never on a host or installed engine.
- **Check the tooling before any startup.** Run `docker compose version`,
  `docker buildx version`, and
  `omni -i run check:compose:rehearsal -p @launchpad-kit/tooling` from the chosen
  source revision. The successful run used Engine 26.1.5, Compose 5.8.0 and
  Buildx 0.39.1 on Debian 13. Compose 2.26.1 failed the mount checks; Compose
  5.8 rejected Buildx 0.13.1. These are observed combinations, not a supported
  minimum version matrix. Do not loosen the checks to accommodate old tools.
- **Capture and verify before transfer.** Use `backup` and `verify-backup` with
  the matching admin image. Archive Dokku and router state only after stopping
  their authorities, preserving numeric ownership and modes. Record the image
  IDs behind the Compose, worker-built and Dokku container references before
  `docker image save`. Verify checksums on source, transfer and target, and
  recheck every reference after `docker image load`. Start with `--no-build`
  and `--pull never`; a rebuilt or freshly pulled image is not a restore.
- **Prepare storage and ports before startup.** Give the target a distinct
  Compose project but recreate the recorded Dokku apps network name on its
  empty engine. Restore the recorded numeric owners. In the rehearsal the
  mounted backup parent as well as the backup contents needed to be accessible
  to `10001:10001`; the admin container could not read through a `0700`
  directory owned by the host login user. Keep every published port on
  loopback. Restore the database into empty storage and revoke restored
  credentials before starting the controller.
- **Check the data plane, then the write gate.** With workers stopped, probe
  both preview hosts through the Dokku port and the alias through the router
  port, using their exact `Host` headers. Compare the deployment identity
  header, not just the status. Use a bounded readiness wait (the retry allowed
  ten minutes after service health). Check the route and generation via the
  authenticated HTTPS control plane. Then verify an authenticated model write
  is blocked, rotate the router under the managed database lock, verify stale
  authority is refused, and reconcile counters. Clear only after the real
  25-minute window and Dokku settlement. If the router was offline during
  restore and the marker used the epoch file, follow the runbook's
  `--router-epoch-unrecorded` attestation after verifying the rotation.

## Result (2026-11-23)

On source revision `efc5f282`, a throwaway guest-only adaptation of the Compose
rehearsal kept a stopped fixture with two deployments and an alias pointing to
B. The 2.1 GiB recovery set passed checksums at all three points. All ten image
references matched on a distinct empty QEMU/KVM target engine. The worktree
adaptation affected the drill tooling; the target used the captured images,
not a build from another revision.

The first target exposed two rehearsal gaps. A `0700` backup parent owned by
the wrong UID blocked `verify-backup` before any database write. After fixing
ownership, a one-shot check immediately after Dokku became healthy interrupted
automatic app recreation. A separate empty retry target, with a bounded HTTP
readiness check, restored the database with zero pending migrations, revoked the
restored credentials, and proved both immutable preview identities and the
alias. Pinned Dokku SSH and authenticated router readback matched the source.
The retry's load-through-route task took 9 minutes 37 seconds; it excludes
source setup, backup, transfer and the write-gate wait.

An authenticated promotion was refused until the managed router rotation,
counter check and `recovery-clear` had completed. The counter check found no
generation drift. Clear passed at 1,935 seconds from the recorded restore start
without accepting any drift. The worker then promoted from B to A at generation
3, withdrew at generation 4 with a verified 404, and deleted both deployments.
Exact-name cleanup verified that all guests shut down and that the disposable
overlays and private transfer copies were removed. This does not verify the
production ingress, host reboot, or a version upgrade and rollback.
