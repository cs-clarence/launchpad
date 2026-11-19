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

Queued. Application milestones 0 to 6 are built (milestone 6 closed 2026-11-18, `docs/plans/milestone-6-release.md`).
The user requested one draft production-preparation PR on 2026-11-19, with this
plan committed first and the package-scope rename next. Its initial implementation
is the `@launchpad-kit` workspace rename, not a production stack. npm scope
ownership remains unverified; publishing or claiming registry namespaces needs
separate verification and explicit authorization.
Requirements this work must meet that the application milestones surfaced:

- Selected product-model direction: one immutable deployment pipeline, with
  unique preview URLs and a stable production alias moved by promotion.
  See `docs/design/deployment-modes.md` for the revised database, routing and API
  proposal. This supersedes separate preview/persistent app paths.
  Aliases are many per app and independently promotable; custom-domain/DNS/TLS
  automation is out of scope, with hostname admission kept separate from routing
  so future external domains can reuse the alias model. Existing
  previews may be retired rather than converted; teardown still requires exact
  identified targets. Routing cutover and reconciliation must be proven before
  this feature is considered ready.

    Readiness review (Opus 5.5): the whole feature is not ready to implement.
    The chosen next step is docs and a separately authorized disposable routing
    experiment, specified in `docs/decisions/immutable-deployment-alias-routing.md`.
    The immutable-model slices/checks/undo in `docs/design/deployment-modes.md`
    are prerequisites of the final installation rehearsal below. A router-control
    contract, alias state machine, permission matrix, quotas and restore boundary
    are now specified; their feasibility is not yet proven.

- The controller and the worker share one data directory and must run as **one user** with read
  and write access; the worker also needs the Docker engine it builds on and SSH to Dokku.
- The worker's stop timeout must outlast a load or rollback (about 24 minutes at the default
  lease); a stop that kills it earlier leaves that deployment held for an administrator (`load-uncertain`).
- Both processes need `LAUNCHPAD_LIFECYCLE` and `LAUNCHPAD_DEPLOYMENTS` to agree; ship a worker
  environment example (`apps/worker/.env.local.example` exists) and document the agreement.
- The worker validates uploaded archives with the same limits as the controller
  (`LAUNCHPAD_MAX_EXPANDED_BYTES`, `LAUNCHPAD_MAX_ARCHIVE_ENTRIES`, `LAUNCHPAD_MAX_ARCHIVE_DEPTH`):
  give both processes the same values, or valid uploads fail at extraction.
- Run the migrations as an explicit step before either process starts, one database per Dokku host
  and per data directory.
- Decide where images for previews live when Dokku is a separate engine (the worker does not remove
  images it loaded onto another host).

Items the milestone 6 review deferred to this work:

- **Worker healthcheck.** Only the controller image has a `HEALTHCHECK`; the worker has no HTTP
  surface. Decide what "healthy" means (a recent `worker_heartbeat` row is the natural signal, which
  needs a small database probe or a heartbeat file) and add it with a check in `test:images`.
- **PostgreSQL client for backups.** The controller image carries no `pg_dump`/`pg_restore`. Provide a
  matching client (an admin sidecar or a documented checkout) and rehearse a backup from the stack.
- **Credential reset after a restore** is manual (`docs/restore.md` step 4). Consider
  `launchpad-admin` commands that revoke every restored API key and session, so a mistake cannot
  leave revoked access working.
- **TLS and connection options.** `backup`/`restore` pass only host, port, user, password, database
  and `sslmode` to the PostgreSQL clients; options such as `sslrootcert` are dropped. Pass them
  through, or document the limit, before a TLS-strict database is used.
- **Base images by digest.** Pin `oven/bun`, `docker` and the Dokku base by digest (a release
  checklist gate in `docs/releasing.md`).
- **Operator install, end to end,** from published artifacts on a clean machine: only possible once
  the stack exists and names are decided.

## Assessment and finish line

- **Kind:** large operational integration, delivered in small PRs.
- **Risk:** High: Docker access is host-root-equivalent; routing untrusted previews
  alongside management can expose credentials; cleanup permanently deletes data.
- **Observed:** the root `docker-compose.yml` currently runs only Dokku, mounts the
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
2. **Separate production configuration:** add `compose.production.yaml`, keeping
   the existing Dokku-only file usable until cleanup/cutover. Move only the external
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
   management origin (`LAUNCHPAD_BASE_URL`), preview domain
   (planned `LAUNCHPAD_APPS_DOMAIN`) and worker's internal proxy/probe address
   (planned `LAUNCHPAD_APPS_PROXY_URL`) separate. Alias control and probes use
   separate `LAUNCHPAD_ALIAS_CONTROL_URL` and `LAUNCHPAD_ALIAS_PROBE_URL`.
   These new names belong to the proposed immutable-model change; the current
   binary still uses `LAUNCHPAD_PREVIEW_DOMAIN` and `LAUNCHPAD_PREVIEW_PROXY_URL`.
   Do not put the planned names into live settings until that change ships.
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
