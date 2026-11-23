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

Upgrade and rollback are not implemented or rehearsed by this task.

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
