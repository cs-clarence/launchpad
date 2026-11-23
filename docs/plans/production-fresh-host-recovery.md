# Fresh-host recovery rehearsal

For operators and maintainers preparing production recovery. This is a
high-risk drill plan, not a cutover or a claim that host-loss recovery works.
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
   **This is the key unknown:** do not assume its previous app containers or
   generated proxy config can be recovered from the state archive alone.
   If automatic recovery does not recreate them, stop and record the gap;
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
