# Repeatable production Compose verification

Medium-sized implementation, high operational risk once Docker resources are
created. For maintainers continuing the [production follow-up](production-compose-follow-up.md).
The aliases-on, certificate rotation and recovery flows have already passed in
disposable Compose projects driven by a temporary script. That script is evidence,
not a safe reusable operator interface: its restart and cleanup logic depend on
the run's in-memory state, and recovery configuration can outlive an interrupted
process. Do not use production credentials, the production project, or existing
Dokku state.

| Step                             | Deliver and verify                                                                                                                                                                                                                                                                                                              | Undo or contain failure                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Fixture preflight             | Generate exact per-run names, a fixture-only environment and image overrides; render the actual Compose model and reject non-loopback ports, unexpected mounts, and any external volume/network. Unit-test unsafe render mutations and verify with Docker Compose without starting anything.                                    | Revert code/docs; the preflight creates nothing.                                                                                                                               |
| 2. Repeatable aliases-on runner  | Add an opt-in Omni task using the preflight and repository rehearsal conventions. Record resource intent before creation, run bind/promote/withdraw and verify both planes. Implement interruption-safe exact-scope cleanup, with explicit retention on failed inventory or settlement. Review it before a disposable live run. | Stop only recorded fixture writers, verify Dokku settlement and remove only proven fixture resources. Keep evidence and inventory if settlement or cleanup cannot be verified. |
| 3. Upgrade and rollback          | Extend that runner only after the baseline passes. Pick and record the previous compatible image revision, back up before migration, upgrade and verify both planes; then restore the matched prior backup into fresh storage before starting the prior image and verifying rollback.                                           | Keep the working fixture and pre-upgrade backup available until the rollback path has passed. Never downgrade a migrated database in place.                                    |
| 4. Recovery and storage coverage | Verify Bun SQL and libpq against the same disposable TLS PostgreSQL, including CA/name refusal. Specify and rehearse offline Dokku and router-state backups separately from the matched DB/archive backup. Add rotation and the real 25-minute recovery mode to the runner after its lifecycle is proven.                       | Preserve the source and existing backups. Restore into disposable targets; keep the mutation gate closed on any refusal or mismatch.                                           |

Finish line: maintainers can run each scenario with named disposable resources
and auditable results without copying a temporary script. This does not authorize
cutover, DNS/ingress changes, claiming registry namespaces or legacy deletion.
Management/apps domains, ingress, proxy trust and the single-host socket threat
model require operator decisions.

## Progress

Step 1 is the render-only task `omni -i run check:compose:rehearsal`. It tests
the fixture model, not Docker resource ownership, port availability or service
readiness.

Step 2 implements `LAUNCHPAD_COMPOSE_REHEARSAL=1 omni -i run test:compose:rehearsal`
for the baseline flow. The earlier manual run did not verify this runner.
The new task validates fixture endpoints and build outputs, uses the local
default Docker builder and records the revision, dirty-worktree flag, version
and local image IDs. It does not force-destroy Dokku apps after a failure:
it stops fixture writers, reads and records the database inventory, and takes
the fixture down only if every recorded deployment is deleted and the Dokku app,
containers and image tags are proven absent. Otherwise leave the project alone
until an operator uses `resources.json` to recover it. A Docker client timeout
also retains the fixture (the daemon may still be working). The runner does not
delete private Compose files and bind data until it verifies that the runtime
resources are gone. Do not publish the private files or any credentials.
Host port selection does not keep reservations across Compose startup; a conflict
must fail startup rather than stop an unrelated service.

The baseline task does not implement upgrade or rollback. A guest-only
rehearsal tested both separately; see [the result](#runtime-upgrade-and-rollback-result-2026-11-23).

### Baseline verification (2026-11-23)

The first reusable run reached healthy startup but rejected a TLS probe outcome
and then verified cleanup. After adding explicit certificate-error checks and
safe probe diagnostics, the retry completed in 337 seconds. It verified:

- Aliases-on bootstrap from local images with explicit migration and operator setup.
- Trusted HTTPS 200, untrusted CA `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, wrong name
  `ERR_TLS_CERT_ALTNAME_INVALID` and plaintext `ECONNRESET`.
- Two immutable deployments, bind to A and promotion to B with matching served
  identities, withdrawal returning 404, and deletion through the API.
- Exact-scope absence of fixture containers, networks, volumes, apps, image tags
  and secret paths.

Evidence, resource inventory and cleanup log:
`/tmp/opencode/lp-compose-b3171c52b17fa4a280a70a78/`. This is the reusable
baseline only; the earlier rotation and recovery results still come from the
separate throwaway rehearsals.

## Upgrade candidate gate

As of the head of draft PR #80 (`635d287`), the first commit with native
aliases-on Compose TLS is `9767e37`. There are no application, package,
Compose or migration changes between those two revisions. The pre-PR base
(`d31db9c`) cannot start aliases on with the Compose control URL from its own
file. Do not use a new label on the same application sources as evidence of
an upgrade, or introduce a fixture-only control proxy and call it the same
topology.

Use `9767e37` or a later known-good aliases-on revision for the source, and
select a distinct candidate with a relevant shipped change. Record both Git
revisions, whether their build inputs are clean, their local image IDs, and the
actual migration statuses before and after. If there is no migration delta,
record that fact: a replacement rehearsal cannot verify migration or schema
rollback. A schema-changing rehearsal needs a real supported source and
target migration, not an invented SQL change.

The merged revisions `300759c` (private router TLS) and `efc5f282` (worker
extraction fix, read-only application containers, and restore credential
revocation) are a distinct source and candidate for a fixture rehearsal.
Both use aliases-on HTTPS and have no migration-file delta. This pair can
verify replacement and rollback to the earlier runtime, not schema rollback
or upgrade between published releases. Before running, plan credential
revocation for the rollback: the earlier admin image must read its own backup,
but it predates `revoke-all-credentials`. Verify the candidate command against
the rollback database and its unchanged auth schema; do not start the earlier
controller until revocation succeeds.

### Worked runtime upgrade and rollback case

Run this as a medium-sized, high-risk rehearsal on one disposable VM, separate
from any installation or other fixture. Keep the Compose namespace, Dokku
storage, apps network and router state across runtime replacement. Use new
image tags for the candidate and new, separately inventoried PostgreSQL and
Launchpad data volumes for rollback. Before bringing up any changed
configuration, recheck loopback bindings, mount paths and resource ownership.
Keep management ingress closed; use only local fixture probes.

| Stage                                                                                                                                                                                                                                                              | Verification and containment                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start `300759c`, deploy A and B and bind the alias to B. Stop and settle the fixture writers, record the exact images, and capture and verify a backup with the prior admin image.                                                                                 | Both preview identities and alias B serve before the gate. Keep the backup and the prior storage and image references intact.                                              |
| Build `efc5f282` under distinct tags; replace the application services using the same fixture state. Run its migration check, then verify the live previews and alias. Promote to A and check a higher generation through both planes.                             | Verify the running image IDs, zero pending migrations, preview identities and that the alias serves A. Stop candidate writers on refusal or mismatch.                      |
| Stop candidate writers, verify Dokku settlement, and restore the prior backup with the prior admin image into empty rollback volumes. Use the candidate admin's offline credential revocation against that rollback database before starting the prior controller. | Verify matching schema and image references, restored archives and expected apps. Preserve both generations of storage; do not downgrade the candidate database in place.  |
| Keep the worker stopped. With the prior controller and fixture router, verify the mutation gate, rotate router authority, reconcile counters, and after the full wait republish the backed-up alias B above the live generation before `recovery-clear`.           | Check pinned SSH, old router credentials refused, exact route readback, and alias B serving. No manual edits to the restore marker or drift overrides.                     |
| After clear, resume the prior worker; promote to A again, withdraw to 404, and delete both deployments.                                                                                                                                                            | Verify generations strictly increase, then confirm exact-name fixture cleanup. If a gate fails, stop identified writers, preserve inventories and keep the backup private. |

Record setup and recovery elapsed time separately. A clean migration status on
both revisions is a prerequisite, not evidence of a schema upgrade or rollback.

1. In the source fixture, keep one live alias and both deployment identities.
   Quiesce mutations; confirm the router and Dokku inventories and take a
   matched backup with the source admin. Keep the backup and source image
   IDs unchanged.
2. Stop and settle the writers; run the candidate admin migrations explicitly.
   Require healthy candidate services, verify both routing planes, and use
   an authenticated alias mutation to show the upgraded worker can dispatch.
3. Stop and settle the candidate writers. Restore the matched pre-upgrade backup
   into fresh database and archive storage using the source admin, not into the
   already migrated database. Keep current router/Dokku state; run the recovery
   gate and full waits before resuming writes on the source images. Verify the
   restored alias and subsequent promotion on both planes.
4. Verify cleanup separately. A failed verification preserves the recorded
   resources for diagnosis, stops identified writers where safe, and is not
   permission to switch or clean up an installed stack.

### Runtime upgrade and rollback result (2026-11-23)

The disposable QEMU/KVM rehearsal passed for `300759c` → `efc5f282` →
`300759c`. The prior admin verified the matched backup with the alias serving B
at generation 2. The candidate ran under separate image tags, retained both
deployment identities, and promoted the alias to A at generation 3, verified
through both router planes. Both revisions reported 19 applied migrations and
zero pending.

With candidate writers stopped, the prior admin restored its backup into fresh
PostgreSQL and Launchpad data volumes. The original volumes were retained until
verification finished. The candidate admin revoked restored credentials against
the unchanged rollback schema before the prior controller started. The restore
marker anchored to the live router epoch. The prior controller refused
authenticated writes; managed rotation rejected stale authority, and counter
reconciliation raised the restored alias to the live generation.

After the full recovery window, the prior admin republished B at generation 4
while writes were still blocked. `recovery-clear` passed at 1,505 seconds
without accepting drift. The prior worker promoted A at generation 5,
withdrew the alias at generation 6 to a verified 404, and deleted both
deployments. Exact-name checks found no deployment containers or images left;
the guest, disposable disk and private backup were removed. This proves a
fixture runtime rollback with no migration delta, not schema rollback or
rollback of an installed production stack.
