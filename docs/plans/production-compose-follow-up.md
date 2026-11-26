# Post-milestone production Compose follow-up

Requested by the user after all application milestones are complete (2026-11-15).
This extends the execution queue beyond milestone 2; do not start production
packaging in place of unfinished application milestones.

**Concrete plan drafted 2026-11-19; awaiting user approval.** Drafting this
document does not authorize starting the eventual production stack or executing
cleanup. The proposals and decision gates below supersede the earlier queue notes
where they are more specific.

## Requested outcome

- Clean up development/test resources created by the agent after milestone work.
  The user approved the intent to retire the existing Dokku/demo setup,
  including its persistent data. Executing deletion remains gated on the approved
  exact target list in slice 5 below. Identify the associated containers, volumes,
  `.data/dokku` and `view-demo` data before deletion. Do not broadly prune Docker
  or touch unrelated resources/data.
- Prepare a production Compose stack with controller, worker, PostgreSQL, Dokku
  and other required dependencies wired together and operationally documented.
- Move the Dokku Dockerfile to `containers/dokku/` and put other custom Dockerfiles
  for external services under `containers/<service>/`. (Launchpad's own controller and worker
  Dockerfiles stay beside their apps, `apps/controller/` and `apps/worker/`; `containers/` is only for
  images of external software.) Update build contexts,
  paths, tooling checks and documentation together.
- Avoid commonly used **host** ports, including 8080 and 443. Distinguish internal
  service ports from host bindings, and settle public TLS/ingress routing before
  claiming the deployment is production-ready.
- Update the relevant `.env.local.example` files and customize the gitignored
  `.env.local` for easy startup. Preserve existing local values, obtain secrets
  through the secret workflow when needed, and never commit local credentials.

## Gate

Reassess and write the concrete High-risk deployment plan when the application
milestones are done. Verify images, privilege boundaries, health/readiness,
durable storage, migrations, secret handling, resource limits, upgrades,
backup/restore and rollback. A syntactically valid Compose file alone is not a
production-readiness claim.

The request authorizes preparing configuration and cleanup of agent-created
resources; it does not require starting the eventual production stack or
publishing images/namespaces.

## Status

The user explicitly authorized the disposable worker/Dokku and alias-router checks
on 2026-11-19 (“Go start those checks”). Their resource inventory, partial results
and cleanup are recorded in [the experiment evidence](routing-experiment-evidence.md).
This does not authorize starting production. Immutable-model integration remains
gated on a complete experiment pass and independent evidence review.

**Current status (2026-11-24).** Production has not been started and no cleanup of old resources
was executed. Since the snapshot below:

- **Router control is secured.** Native HTTPS with operator-provisioned certificates replaced the
  plaintext control URL (2026-11-22); aliases-on bind, promote, withdraw and reconciliation passed.
- **Recovery is rehearsed on disposable QEMU/KVM guests.** Dokku and router state backups, whole-host
  recovery, credential revocation (`revoke-all-credentials`), `recovery-clear`, PostgreSQL client TLS
  options, and a runtime upgrade and rollback across two revisions all passed. Database loss, worker liveness
  and failed restores (a corrupted import put back, a killed importer and its acknowledgement) were rehearsed on
  the aliases-on Compose topology on 2026-11-26 ([evidence](evidence/rehearsal-db-worker-restore-20261126/README.md)); schema rollback is still untested
  because the revisions had no migration delta (only the two refusals were rehearsed).
- **Install and ingress.** A clean install and an orderly reboot passed. The ingress contract was verified
  with a disposable reverse proxy and synthetic hostnames ([guide](../ingress-example.md)); real domains,
  DNS, certificates and proxy trust are chosen per installation.
- **Reusable tasks.** `test:compose:rehearsal` is the checked-in baseline. The fresh-host, reboot, upgrade
  and ingress drills used throwaway guest-only adaptations that are not checked in.
- **Schema.** The pre-release migrations were replaced by one v1 baseline ([plan](v1-schema-baseline.md)).
- **Still open:** cleanup of old resources (needs an approved exact list), the product follow-ups from the
  2026-11-26 rehearsal (a worker staleness signal, `migrate` over an orphaned data directory, a controller that
  notices a replaced database; see the [evidence](evidence/rehearsal-db-worker-restore-20261126/README.md#defects-and-follow-ups-recorded-not-fixed)), a held
  promotion on Compose, schema rollback with a real migration delta, and the decisions listed in the
  outstanding follow-ups below.

**Historical snapshot (2026-11-21, after the first disposable rehearsal).** Evidence:
[`evidence/p7-compose-20261121/`](evidence/p7-compose-20261121/README.md). Production has not been
started and **no cleanup of old resources was executed**.

- **Slice 1 (topology proof): done for deployments on, aliases off.** Unique project, volumes, keys and
  loopback ports; worker-to-Dokku SSH with pinned host key, host-visible Dokku mounts, image loading, proxy
  readiness, one fixture deploy/probe/delete and exact-name teardown (verified absent) all worked. The
  "Dokku joins the default bridge via Compose" design **failed** (the engine rejects Compose's aliases) and
  was replaced by a dedicated `apps` network plus `network:set --global initial-network`.
- **Slice 2 (configuration): done and now run once.** Open items closed: external images and the
  `dokku-http-auth` plugin are pinned (tag plus digest, commit), resource limits are set from measurements
  (small rehearsal only), `check:compose` asserts both. Four configuration defects fixed (plugin
  `--committish` syntax, default-bridge attachment, Dokku healthcheck and start period, password-file
  ownership doc). The user approved loopback port 32182 for the router data plane.
  **Blocker found (resolved 2026-11-22):** `LAUNCHPAD_ALIASES=on` could not work because the worker and controller require an HTTPS or
  `http://127.0.0.1` router control URL and the router control plane is plain HTTP on the private network
  (`http://router:3081`); needs a decision (TLS on the control plane or a loopback path).
- **Slice 3 (backup/restore): partly done.** From the stack: admin `backup`, `verify-backup`, restore into a
  fresh database and data volume, `migrate --status`, `check-restore`, and artifacts surviving
  recreation. **Not done:** startup schema guards and failed-restore recovery, rollback to the previous
  image with its pre-upgrade backup, `recovery-clear` and starting a controller on the restored data, TLS
  option pass-through to the PostgreSQL clients, the credential-reset command, Dokku-state and router-state
  backup, revoked credentials unusable after restore.
- **Slice 2/behavior observed:** a worker stopped mid-deploy ends the run `authority-lost` at once and the
  deployment becomes `reconciliation-needed` after the lease (about 170 s); the graceful-stop claim "finishes
  within the 25-minute grace" is false for in-flight deployments.
- **Not done:** slice 4 (domains, ingress, TLS, installation rehearsal with aliases, upgrade/restart), slice 5
  (cleanup), a reusable opt-in task for this rehearsal (it was run by hand), the stable worker id.

The user requested one draft production-preparation PR on 2026-11-19, with this
plan committed first and the package-scope rename next. Its initial implementation
is the `@launchpad-kit` workspace rename, not a production stack. npm scope
ownership remains unverified; publishing or claiming registry namespaces needs
separate verification and explicit authorization.
Requirements this work must meet that the application milestones surfaced:

- Drift detection: a read-only report comparing the database, Dokku and the alias
  router, specified in `docs/design/deployment-modes.md` (§Drift detection). It
  reports orphans and mismatches and never repairs or deletes; deleting an orphan is
  a separate authorized action. Cleanup of the old demo data uses an exact-name
  inventory like this report, not a pattern match.

- Selected product-model direction: one immutable deployment pipeline, with
  unique preview URLs and a stable production alias moved by promotion.
  See `docs/design/deployment-modes.md` for the revised database, routing and API
  proposal.
  Aliases are many per app and independently promotable; custom-domain/DNS/TLS
  automation is out of scope, with hostname admission kept separate from routing
  so future external domains can reuse the alias model. Routing cutover and reconciliation must be proven before
  this feature is considered ready.

    Readiness review (Opus 5.5): the whole feature is not ready to implement.
    The chosen next step is docs and a separately authorized disposable routing
    experiment, specified in `docs/decisions/deployment-alias-routing.md`.
    The immutable-model slices/checks/undo in `docs/design/deployment-modes.md`
    are prerequisites of the final installation rehearsal below. A router-control
    contract, alias state machine, permission matrix, quotas and restore boundary
    are now specified; their feasibility is not yet proven.

- The controller and the worker share one data directory and must run as **one user** with read
  and write access; the worker also needs the Docker engine it builds on and SSH to Dokku.
- Stopping the worker does **not** drain a deployment in flight, whatever the stop timeout: the run
  ends `authority-lost` at once and the deployment is held for reconciliation after its lease
  (rehearsed 2026-11-21, about 170 s; see [production Compose](../production-compose.md#stopping-and-restarting-the-worker)).
  The 25-minute `stop_grace_period` only bounds how long Docker waits before killing the container.
  Whether to drain instead is an open product decision.
- Both processes need `LAUNCHPAD_DEPLOYMENTS` to agree; ship a worker
  environment example (`apps/worker/.env.local.example` exists) and document the agreement.
- The worker validates uploaded archives with the same limits as the controller
  (`LAUNCHPAD_MAX_EXPANDED_BYTES`, `LAUNCHPAD_MAX_ARCHIVE_ENTRIES`, `LAUNCHPAD_MAX_ARCHIVE_DEPTH`):
  give both processes the same values, or valid uploads fail at extraction.
- Run the migrations as an explicit step before either process starts, one database per Dokku host
  and per data directory.
- Decide where images for previews live when Dokku is a separate engine (the worker does not remove
  images it loaded onto another host).

Items the milestone 6 review deferred to this work:

- **Worker healthcheck (done).** The worker image now has a `HEALTHCHECK` that reads a file the
  worker updates while active or idle. It measures liveness only.
- **PostgreSQL client for backups (done).** The one-off operator image (`--target admin` of the
  controller Dockerfile) carries PostgreSQL 17 client tools and is checked by `test:images`.
  Original note: the controller image carries no `pg_dump`/`pg_restore`. Provide a
  matching client (an admin sidecar or a documented checkout) and rehearse a backup from the stack.
- **Credential reset after a restore (done 2026-11-23).** `revoke-all-credentials
  --i-understand-this-signs-everyone-out` deletes every restored session and emailed token and
  revokes every API key and open invitation in one audited transaction; `restore.md` step 4 uses
  it. It changes no password (`reset-password` does that per account) and cannot revoke what is
  issued while it runs, so it is documented as an offline step. Covered by a PostgreSQL integration
  test and a built-admin run; **not** yet exercised inside a full Compose restore drill.
- **TLS and connection options (code prepared 2026-11-22).** `backup`/`restore` now
  preserve the allowlisted PostgreSQL 17 TLS options and refuse unknown, duplicate
  or empty query options. See [the exact contract](../backup.md#database-connection-options)
  and [slice checks](production-pg-client-options.md). A later disposable drill
  verified Bun SQL and libpq against a TLS-required PostgreSQL 17 server, including
  wrong-CA and wrong-host refusal and a backup/restore with the built admin.
- **Separate state backups (same-host drill passed 2026-11-23).** Offline
  Dokku and router archives restored to fresh destinations, preserving the host
  key, app inventory and active route. Both data paths and a new promotion
  passed. See [scope and evidence](production-state-backup-rehearsal.md).
  Host-loss recovery remains unverified.
- **Base images by digest (done 2026-11-21 for the application, router, worker and Dokku images and Postgres).** Pin `oven/bun`, `docker` and the Dokku base by digest (a release
  checklist gate in `docs/releasing.md`).
- **Operator install, end to end,** from published artifacts on a clean machine: only possible once
  the stack exists and names are decided.

## Assessment and finish line

- **Kind:** large operational integration, delivered in small PRs.
- **Risk:** High: Docker access is host-root-equivalent; routing untrusted previews
  alongside management can expose credentials; cleanup permanently deletes data.
- **Observed:** the root `docker-compose.yml` (since replaced by `docker-compose.yaml`) then ran only Dokku, mounted the
  host Docker socket and `.data/dokku`, and publishes loopback ports 3022, 9080 and 8443. Its image recipe is the root `Dockerfile`. Controller/worker recipes and
  their ignore files are now beside their apps. Both apps use UID/GID 10001 and
  share `/data`. Migrations and restore are explicit admin operations.
- **Reuse:** existing image, package, upgrade and restore checks, the private
  management/routing runbooks, pinned SSH trust, and the fixed Dokku vocabulary.
- **Execution:** one owner integrates the work; read-only Opus review before each
  nontrivial push, then CI and CodeRabbit on the latest head before squash merge.
  No parallel implementation until the engine/network/storage contracts are settled.

Done means a reviewed Compose stack and operator procedure, tested on isolated
disposable infrastructure, plus exact-scope cleanup with a retained result record.
It does **not** mean a running production installation, a published release, or a
claim that this host safely runs arbitrary hostile tenants.

## Proposed architecture and decisions

These are proposals for approval, not assumptions already authorized.

1. **One host, one Docker engine for worker builds and Dokku apps.**
   Reuse the existing Dokku socket-based model. Both Dokku and the worker have
   host-root-equivalent engine access; the controller and database never do.
   The worker already accepts `DOCKER_HOST`; using an engine in a VM should
   generally be configuration, not a new application engine abstraction. Both
   same-host and VM-hosted engines must be documented with their mount visibility,
   SSH/proxy connectivity and image-cleanup implications. A VM provides stronger
   host isolation only when its Docker engine is inside the VM: mounting the main
   host's socket still grants main-host control. Do not expose an unauthenticated
   Docker API on TCP. The operator chooses the topology and its security boundary.
2. **Production configuration:** `docker-compose.yaml` replaces the Dokku-only
   file without adopting its persistent state. Move only the external
   Dokku recipe to `containers/dokku/Dockerfile`; keep application recipes beside
   their projects. Use explicit Compose project identity and no fixed container
   names for new application services.
3. **Services:** PostgreSQL 17, controller, worker, Dokku, and an opt-in admin
   service carrying the same controller build plus compatible PostgreSQL clients.
   Admin has no restart policy and is never started by ordinary `up`. Migrations,
   operator setup, backup and restore remain explicit one-shot commands. If
   `check-restore` needs SSH credentials, mount them only into that admin invocation.
   Avoid a second independently versioned admin application.
4. **Persistent state:** a shared controller/worker artifact volume owned by
   10001:10001, separate PostgreSQL storage, and an absolute physical host bind
   for Dokku state. Dokku's host-path settings must match the actual bind source
   seen by the host engine. Initialization changes ownership only on a newly
   created, explicitly identified directory/volume—not recursively on existing
   user paths. Backups live outside all cleanup targets.
5. **Networking:** a private database network, app-to-Dokku SSH/proxy reachability,
   and no published PostgreSQL or worker port. User-approved default host bindings, all
   **loopback-only**: controller 32180, Dokku SSH 32222, preview HTTP 32181 and
   optional preview HTTPS 32443. Internal service ports remain 3000/22/80/443/5432.
   Check availability before writing local settings; conflicts require a revised
   allocation, never stopping the process that owns a port.
6. **Ingress is configurable, not a mandatory provider or access policy.**
   The operator independently chooses public HTTPS or private access (Tailscale,
   another VPN, a tunnel or a reverse proxy) for management and previews. Keep the
   management origin (`LAUNCHPAD_BASE_URL`), apps domain
   (`LAUNCHPAD_APPS_DOMAIN`) and worker's internal proxy/probe address
   (`LAUNCHPAD_APPS_PROXY_URL`) separate. Alias control and probes use
   separate `LAUNCHPAD_ALIAS_CONTROL_URL` and `LAUNCHPAD_ALIAS_PROBE_URL`.
   Public browser/client URLs must not
   accidentally use Docker service DNS names; the internal probe need not use the
   public preview route. Loopback bindings remain safe defaults, with an explicit
   operator-controlled bind/ingress override and documented exposure consequences.
   Public management must retain authentication, HTTPS and origin/proxy safeguards;
   Tailscale is optional, not an application dependency.
   Management and previews still require different registrable
   domains, not merely different subdomains: that is the existing untrusted-content
   security boundary, independent of public versus private access.
   Existing Cloudflare/Playit connectors
   are not adopted, reconfigured or stopped without identifying their owner and
   obtaining approval for that change. Set trusted
   proxy mode only after verifying the exact forwarded-IP chain.
7. **Safe defaults:** deployments and lifecycle off in both apps; public signup
   off; API docs private/disabled as appropriate. Controller and worker share
   limits, artifact location and lifecycle settings from one Compose definition.
   Worker gets a stable explicit worker ID and at least 25 minutes stop grace.
   Add measured resource limits and log rotation without privileged app containers.
8. **Secrets:** root `.env.local` holds Compose interpolation settings, not a
   blanket `env_file` supplied to every service. Pass only allowlisted settings
   per service. Mount SSH key/known-hosts read-only, preserving their required
   modes; verify host keys out of band. Obtain new secrets through the secret
   workflow, never in chat or Git. Preserve existing local settings and keep a
   private rollback copy before a narrowly scoped update; tests must not inherit
   production `.env.local` values.

### Choices still needing the user

- Loopback port defaults are approved. The operator chooses whether the engine
  runs on the same host or inside a dedicated VM; retain configuration flexibility.
- Public/private management and preview access are independent operator choices.
  Implement configurable endpoints and provider-neutral documentation without
  requiring a Tailscale or Cloudflare account. Actual domains and routing are
  still required before any local routing integration or endpoint customization.
- Confirm production storage/backup locations and retention. Proposed defaults
  are separate named app/database volumes and a new Dokku bind, not adoption of
  the old demo state.
- The user requested deletion of the old demo data without retaining an archive.
  Identify the exact old demo/Dokku targets before deleting them. Ambiguous or
  newly discovered targets remain excluded until identified and confirmed; this
  is not permission to delete unrelated data or begin the eventual production stack.

## Slices, checks and undo

### 1. Inventory and prove the risky topology

After plan approval, read-only inventory of Docker contexts/engines, Compose
labels, containers, volumes, bind sources, networks, image references and occupied
ports. Identify existing Dokku/demo resources, disposable test resources, and
unrelated connectors separately. Record IDs, paths and ownership evidence without
dumping container environment variables or secret contents into tracked docs.

First experiment: a separately authorized disposable stack with unique project,
volumes, keys and ports. Prove worker-to-Dokku SSH trust, host-visible Dokku mounts,
image loading, proxy readiness and exact-name teardown using only `lp-test-` apps.
If this fails, revise the architecture before building the remaining stack.

**Check:** no existing resource modified; one fixture deploy/probe/delete succeeds
and disposable ownership is unambiguous. **Undo:** stop/remove only resources
created and recorded by this experiment; report leftovers. Production is untouched.

### 2. Runnable configuration and admin lifecycle

Move the root Dokku Dockerfile and update its Compose reference and checks
together. Add the production Compose definition, example settings, opt-in admin
image/service, health dependencies, secret mounts and initialization procedure.
Pin external images by verified digest and the Dokku plugin by immutable commit;
record the source/version rather than guessing a digest. Keep local image tags
distinct from any published namespace.

Implement worker health as a bounded probe of its own heartbeat when enabled,
with an explicit healthy-idle result when deployments are off. A recent heartbeat
alone is liveness, not proof Dokku or deployment readiness; document the distinction.
Verify database outage, stale worker and graceful shutdown behavior.

**Check:** through Omni, render example Compose without secrets; assert networks,
port bindings, service-specific credentials, matching settings, healthchecks,
restart policies and 25-minute stop grace. Run image checks, including the admin's
client versions and worker unhealthy/idle states. Bootstrap checks need no live
infrastructure. **Undo:** revert configuration changes; no running stack changes.

### 3. Backup/restore and access recovery from the stack

Document and test matched database/artifact backup from the admin service,
fresh-database restore, explicit migrations, startup schema guards and rollback
using the previous image and its pre-upgrade backup. Preserve the full remote
settling wait in the real runbook. Carry supported TLS connection options to the
PostgreSQL clients, and reject unsupported options rather than silently losing
connection security settings.

Assess a small offline admin operation to invalidate all restored sessions, reset
tokens and API keys transactionally, with audit output and explicit confirmation;
do not silently broaden this into a user/role administration feature. Membership
and role reconciliation still needs the external change record and authorized
organization members. Keep management access closed until reconciled.

**Check:** disposable round trip, failed restore recovery, revoked credentials
remain unusable, TLS settings reach the client, schema mismatch fails closed,
and archives survive container recreation. **Undo:** restore the pre-change matched
backup to a fresh database; do not attempt down migrations or reuse migrated data
with an older application.

### 4. Routing, local settings and installation rehearsal

Once domains/ingress are approved, write the concrete HTTPS and trust-boundary
procedure and customize only the agreed keys in gitignored local configuration.
Do not start the eventual production stack. Rehearse an operator install from
locally built artifacts on a disposable environment: explicit migration/setup,
authenticated status, upload/deploy, preview routing, expiry extension, deletion,
backup/restore, then an upgrade/restart. Public/cross-host routing verification
needs separate permission and its own test endpoints.

**Check:** management is inaccessible through preview ingress, database/Docker/SSH
are not public, controller cookies do not reach previews, correct client-IP handling,
and disabled workers stay idle. **Undo:** remove only new test routes/records and
restore the private local-settings copy; never overwrite unrelated tunnel config.

### 5. Exact-scope final cleanup

Only after verification and an approved inventory, stop the identified old
Dokku/demo setup. Capture the final target list immediately before deletion:
container IDs, volume names, physical bind paths, app names and exact images.
Exclude anything referenced by unrelated resources, the new configuration,
backups, other checkouts, and Cloudflare/Playit connectors.

Delete the approved `view-demo` and legacy Dokku state, agent-created test apps
and disposable state by exact names/paths. Never use broad Docker prune,
`compose down -v` against an ambiguous project, or recursive deletion of `.data/`
or `/tmp/opencode/`. Never follow a symlink into an unapproved path.

**Check:** recorded targets absent, unrelated resource IDs/state unchanged,
working tree clean apart from intentional configuration, no credential in Git.
Record what was deleted and what was deliberately retained.
**Undo:** stopping is reversible; **persistent-data deletion is not**, unless
the user elected and verified an offline archive. Stop before irreversible work
if ownership, dependencies or backup scope are unclear.

## Outstanding follow-ups after the bundled P7 PR

The [repeatable rehearsal plan](production-compose-rehearsal.md) orders the
remaining disposable verification: fixture preflight and aliases-on runner,
then upgrade/rollback and TLS/storage recovery checks.

For maintainers planning the next production milestones. The [disposable Compose
record](evidence/p7-compose-20261121/README.md) is the baseline. These checks are
exit criteria, not authorization to start production or delete existing state.

| Priority                                                                                                                                                                                                                                                                                                                                                                                                  | Follow-up                                                                                                                                                                                                                                                                                  | Close when                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Functional blocker (done 2026-11-22: [record](deployment-p7-acceptance.md#aliases-on-compose-rehearsal-2026-11-22))                                                                                                                                                                                                                                                                                       | Secure the router control connection. Choose private HTTPS or a literal loopback topology without weakening URL validation or publishing the control port.                                                                                                                                 | An aliases-on Compose run starts and exercises bind, promote, withdraw and reconciliation through both router planes.                                                                                                                    |
| Cutover gate (contract verified with a disposable ingress 2026-11-23: [example](../ingress-example.md); domains, DNS and proxy trust remain installation decisions)                                                                                                                                                                                                                                       | Choose separate management and apps registrable domains, configure app wildcard DNS and HTTPS ingress, and settle proxy trust.                                                                                                                                                             | The intended clients can reach deployment and alias hosts; app ingress cannot reach management; management cookies stay off app hosts; forwarded IPs are trusted only from the intended proxy; database, Docker and SSH are not exposed. |
| Install follow-up (clean install and reboot passed 2026-11-23 with a rehearsal runner: [result](production-compose-install-reboot.md#result-2026-11-23))                                                                                                                                                                                                                                                  | Make fresh-host bootstrap repeatable, including Dokku's `initial-network`, pinned SSH trust, storage ownership, migrations, operator setup and router init.                                                                                                                                | A clean disposable install follows the runbook successfully without an undocumented manual fix.                                                                                                                                          |
| Reliability gate (stop-and-reconcile behavior documented and rehearsed; the drain decision remains yours)                                                                                                                                                                                                                                                                                                 | Decide whether to drain in-flight deploys on shutdown or explicitly support the current stop-and-reconcile behavior.                                                                                                                                                                       | A stop during deployment has a documented, rehearsed recovery path; the stop-grace setting is not represented as a drain guarantee.                                                                                                      |
| Recovery gate (mostly done 2026-11-23: [fresh-host](production-fresh-host-recovery.md#result-2026-11-23), [runtime rollback](production-compose-rehearsal.md#runtime-upgrade-and-rollback-result-2026-11-23); failed restores rehearsed on the Compose topology 2026-11-26: [evidence](evidence/rehearsal-db-worker-restore-20261126/README.md); schema rollback with a real migration delta is untested) | Add procedures for Dokku and router state backups; test post-restore startup, failed restore, reconciliation against a newer router, `recovery-clear`, and Compose upgrade and rollback. Finish PostgreSQL client TLS-option handling and settle how restored credentials are invalidated. | Disposable drills demonstrate a safe return to service, including the mutation gate, schema compatibility and revoked credentials staying unusable.                                                                                      |
| Capacity gate (partly done 2026-11-23: [measurements](../production-compose.md#measured-at-the-default-limits-2026-11-23); host reboot rehearsed; database loss and worker liveness rehearsed 2026-11-26: [evidence](evidence/rehearsal-db-worker-restore-20261126/README.md); no staleness signal for a dead worker, see the defects there)                                                              | Measure large archives, concurrent deploys, many apps, backup/restore and first startup. Account separately for Docker builds outside service limits.                                                                                                                                      | Limits are based on representative load; database loss, worker liveness and host reboot are rehearsed.                                                                                                                                   |
| Security and operations (hardening assessed 2026-11-23: [decisions](../production-compose.md#hardening); the socket decision remains yours)                                                                                                                                                                                                                                                               | Confirm the single-host, root-equivalent Docker socket threat model. Assess file-based database secrets, read-only root filesystems and SMTP if the installation needs email.                                                                                                              | The operator explicitly accepts the boundary or selects a more isolated topology; each optional hardening item is adopted or deferred with a reason.                                                                                     |
| Reproducibility (app-base digest done 2026-11-23; OS packages deliberately unpinned, see [images](../production-compose.md#images-and-pins))                                                                                                                                                                                                                                                              | Rehearse the existing app-base digest support with a verified registry digest; assess pinning OS packages installed by the admin image and Dokku.                                                                                                                                          | The app base can be built from a verified digest; remaining package inputs have an explicit pin or update policy.                                                                                                                        |

Legacy cleanup is separately gated on an approved exact target list; it does not
block a fresh install. Automatic expiry and retention extension are product
follow-ups, not Compose defects.

The [clean-host recovery rehearsal](production-fresh-host-recovery.md#result-2026-11-23)
passed, including write recovery, on disposable guests. A separate
[clean install and orderly reboot](production-compose-install-reboot.md#result-2026-11-23)
also passed. The [runtime upgrade and rollback rehearsal](production-compose-rehearsal.md#runtime-upgrade-and-rollback-result-2026-11-23)
passed across two distinct aliases-on revisions with no migration delta.

### Rehearsal scenarios not yet reproduced

The [2026-11-26 rehearsals](evidence/rehearsal-db-worker-restore-20261126/README.md) could not
reproduce these; they stay open and are recorded, not fixed.

- **Held promotion.** A promotion takes about 3 s, shorter than the `dispatch` step can be caught, so the
  `promotion-reconcile` branch (a promotion held after its worker died) was not exercised. A paused router leaves the
  operation `applying`; after the lease the next claim resumes it. Needs a way to slow or hold the dispatch step.
- **Backup killed mid-write.** A backup of the rehearsal database takes about 1 s, so a kill landed either before the
  dump started (no manifest, never verified) or after it finished. Needs a much larger database or a slowed dump.
- **Unclassified `ERR_POSTGRES_CONNECTION_CLOSED`.** No fault produced this driver error, so it is not mapped to
  `database-unavailable`. A connection that drops in flight can answer 500 on a request route until the next schema
  check; `/api/ready` reports 503 and `/api/health` stays 200. Capture a real shape (for example a server restart
  during a query) before classifying it.

### Private router control: approved implementation

Recommend private HTTPS over Compose DNS, rather than sharing the router's network
namespace with the worker and one-off admin commands. HTTPS keeps the router off
the database network and retains the existing HTTPS-or-literal-loopback client
rule. Keep the control port unpublished and the data-plane path unchanged.

The user approved operator-provisioned certificates and explicit operator
rotation on 2026-11-22. Native control HTTPS and scoped client CA trust are
prepared; [the implementation/check plan](production-router-control-tls.md) and
[operator procedure](../production-compose.md#router-control-certificates) record
the contract. The router gets the server key; only control clients in worker,
admin and the router's verified health checker get the public CA bundle. The
CA private key is never mounted. Loopback checks verify trusted TLS, refusal of
an untrusted certificate or wrong server name, bind, promote and withdraw;
Compose assertions keep the control port unpublished. Bind, promote, withdraw
and reconciliation passed in one aliases-on disposable Compose run on 2026-11-22
(see the P7 acceptance record); certificate and CA rotation also passed there.
The later recovery and runtime rollback results are linked above. Leave aliases
off on an actual installation until its own transport and ingress checks pass.
Undo pre-cutover by reverting the transport configuration; once
aliases are live, quiesce mutation dispatch and preserve router state and pins
before reverting. Do not fall back to plaintext on the bridge.

### Public app ingress

A wildcard tunnel can point at one loopback app ingress. Preserve the requested
`Host` and select the backend from the hostname, not from the backend's HTTP
response: immutable deployment names go to Dokku and alias names go to the
router's data plane. If routing by the generated name shapes, require
nonoverlapping deployment and alias templates; changing either template must not
break routing for existing names. Never fall back to Dokku on a router 404: an
unbound or withdrawn alias is supposed to stay a 404.

Before connecting a real wildcard, prove those routes with synthetic hostnames
on a [disposable ingress](../ingress-example.md). Check a known deployment and alias, an unknown host,
and a withdrawn alias. None may reach management, router control or Dokku SSH.
Keep management on a different registrable domain and a separate private
listener. Undo by removing only the new app ingress route or binding.

## Verification and handback

- Run the full Omni gate at integration, then the affected image, upgrade,
  package and Compose checks. Keep disposable live tests opt-in and separately
  approved; no production credentials in CI.
- Require independent review of security/storage/routing contracts and of the
  final destructive target list; review does not authorize executing deletion.
- The draft umbrella PR was requested; committing and pushing its preparation
  work does not authorize deployment, publishing or cleanup. During approved
  implementation use the existing requested PR/review workflow.
- Report configuration prepared, disposable behavior verified, cleanup completed,
  and production **not started** as separate outcomes. Published-artifact install
  and actual production cutover remain unproven until separately authorized.

## Cleanup record

### Old demo data (2026-11-19, executed by explicit user instruction, no archive kept)

Exact targets, identified before deletion by labels and creation time and deleted by exact name:

- Container `view-demo.web.1` (Dokku app `view-demo`, exited, no mounts).
- Images `dokku/view-demo:latest` and `launchpad/hello:v1` (the demo's source image; rebuildable from `examples/hello`).
- Directory `.data/dokku` (the old repository-local Dokku state; root-owned, removed with a throwaway container mounting only `.data`).

Verified afterwards: the container and both images are gone and `.data` is empty. The
`cloudflare-connector` and `playit-connector` containers were not touched.

### Left in place, with the reason

- `launchpad-live-dokku` and its state under `/tmp/opencode/live-dokku-20261117/`, plus the
  `launchpad/dokku:0.38.34` image: agent-created and still needed for the routing experiment.
- Eight unnamed, unused Docker volumes created 2026-11-18 between 13:16 and 13:19 (+08:00), matching
  test runs. No container references them, but nothing proves who made them, so they stay until
  that is confirmed.
- Images `launchpad-check/controller:dev` and `launchpad-check/worker:dev`: probably earlier agent builds; not confirmed.
- Existing `postgres`, `node`, `alpine`, `oven/bun`, `docker` and linter images: shared base images, not Launchpad's.
