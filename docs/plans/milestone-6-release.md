# Milestone 6: install, back up, upgrade, package

Status: **approved by the user (2026-11-18), all nine decisions as proposed; decision 3 was then amended to extend the existing admin command instead of a new package (a smaller change; flagged in the summary to the user).** Extends
`docs/plans/application.md` milestone 6. High risk: it changes how data is migrated,
restored and shipped, and it produces artifacts that are hard to take back.

## Assessment

- **Kind:** large (several independent slices; new operator commands; packaging of every
  published surface).
- **Risk:** High. A wrong backup or restore loses or duplicates previews and can make the
  lifecycle destroy a live app; a published npm package or image cannot be unpublished; a
  migration step that runs implicitly can corrupt a database on upgrade.
- **Reused, not redone:** forward-only migrations in `packages/database/src/migrations`,
  the operator commands in `packages/auth`, `GET /api/v1/status`, the worker's lifecycle
  and deployment switches (both default off), the restore order in `docs/plans/application.md`
  (seven steps), `.env.local.example` files, and the CI workflow.
- **Execution:** solo, one PR per slice; Opus review before each push as before, and an
  independent review of slices 2 and 3 (restore and upgrade) and of the whole milestone.
- **Undo:** each slice is additive and off by default. Nothing is published, pushed to a
  registry, tagged or started by this milestone without a separate explicit go-ahead.

## Outcome

An operator can install Launchpad on a clean machine from built artifacts, take a backup,
restore it by a documented and drilled procedure, upgrade from the previous version
without losing data, and a user can install the CLI, SDK and MCP server from packed
tarballs on Node or Bun without the workspace. All of it is proven by tests that need no
live infrastructure, plus a drill an operator can repeat.

## Decisions to approve

1. **Scope boundary with the production Compose follow-up.** This milestone ships the
   _pieces_ (image recipes, migrate command, backup and restore commands, packed npm
   packages, docs) and proves them with CI checks. The finished production Compose stack,
   moving the Dockerfiles under `containers/`, host-port choices, `.env.local` customisation and
   cleanup of the existing demo stay in `docs/plans/production-compose-follow-up.md`, after
   this milestone. Proposed: yes.
2. **Backup format.** One directory or `.tar` per backup holding a `pg_dump` custom-format
   dump, the data directory (artifacts), a manifest (schema version, Launchpad version,
   time, per-file sha256) and no secrets (`.env` files, API keys and the Better Auth secret
   are excluded and listed as "back up separately"). Proposed: yes. Alternative: documented
   `pg_dump` plus `tar` only, with no command.
3. **Who runs backup and restore.** The existing operator command `launchpad-admin`
   (`apps/controller/src/admin/main.ts`, which already has `migrate`, `setup`, `create-user`
   and `reset-password`), not the CLI: the CLI is an API-key client and must never touch the
   database. (Found while starting slice 1: the first draft proposed a new `apps/admin`
   package; extending the existing command is smaller and keeps one operator entry point. If
   packaging the controller later wants it split out, that is a mechanical move.) It needs
   `DATABASE_URL`, runs `pg_dump`/`pg_restore` from the host's PostgreSQL client, and refuses
   to restore unless the workers are provably stopped (see 4). Proposed: yes.
4. **Restore safety.** The primary requirement is the runbook's step 1 in
   `docs/plans/application.md`: lifecycle and deployments off, every worker **stopped and
   waited for**, and remote destroys given time to settle. A command cannot prove that: an
   expired heartbeat does not show a worker has exited. So `restore` requires the operator's
   explicit confirmation that step 1 is done (`--i-have-stopped-the-workers`, which confirms
   the whole step, not only the heartbeat), and, as a secondary safety net, also refuses
   while a worker heartbeat in the live database is recent, whatever the flag says. It never
   touches Dokku. After restore it prints the remaining steps of the runbook. A `check-restore`
   command does the read-only detection steps 3 and 4 (every live artifact has its file; list
   live previews whose Dokku app is gone via the allowlisted `apps:exists`). It never redeploys
   or deletes. Proposed: yes.
5. **Migrations.** The existing `launchpad-admin migrate` command (and `migrate --status`, a dry run
   listing pending migrations) that is the only thing that applies migrations in a
   packaged install; processes check the schema version at start and refuse to run against
   an older or newer one. Forward-only stays; rollback means restore of the pre-upgrade
   backup. The upgrade procedure requires a backup first and the command prints a warning
   if none is recorded. Proposed: yes.
6. **Packaging.** Publishable, compiled, versioned packages: `@launchpad/cli`, `@launchpad/mcp`,
   `@launchpad/sdk` (with `contracts` and `client-core` bundled or published as
   dependencies; the choice is made in slice 4 by what keeps the allowlist smallest).
   Compiled JS plus declarations, `exports` map, `bin` entries with a shebang for Node and
   Bun, a `files` allowlist, dependency ranges, no workspace `workspace:` specifiers. The
   names are **placeholders**: the npm scope and product name are undecided and are not
   registered. Proposed: yes.
7. **Images.** Controller and worker Dockerfiles under `containers/controller/` and
   `containers/worker/`, multi-stage, non-root (one fixed uid for both, because they share the
   data directory), migrations folder copied in, no secrets in layers, healthcheck. Built
   in CI, **not pushed**. The Dokku Dockerfile moves in the follow-up, not here.
   Proposed: yes.
8. **Version and release machinery.** Implement the cog pre-bump hook that synchronizes
   versions and the lockfile across packages and add a dry-run release workflow that packs
   and builds but publishes nothing; real publishing needs a later explicit authorization,
   a least-privilege identity and provenance. Proposed: yes.
9. **Supported platforms.** Node LTS and the current Bun for the CLI, MCP and SDK;
   Linux for the controller and worker images (amd64; arm64 deferred). Proposed: yes.

## Slices

Each slice is one PR, with checks green and a self-review before the review round.

1. **Schema version and migrate command.** Record the applied migrations (already stored) as a
   schema version; `migrate --status` on the existing admin command; the controller and
   worker refuse to start on a mismatched schema; the migrations folder is located by
   one resolver that also works from a packaged layout. Tests: against a disposable
   PostgreSQL (empty, current, behind, ahead).
2. **Backup.** `launchpad-admin backup <dir>`: consistent dump, copy of the data
   directory, manifest with checksums; secrets excluded; refuses to overwrite; verifies its
   own output. **One consistent snapshot of both sources:** the
   database is dumped first and the data directory copied after it, then the command checks
   that every live artifact row in the dump has its file in the copy and fails if one does not.
   An archive uploaded in between is only an extra file (archives are immutable and named by
   their digest), and only the lifecycle's collection removes one, so `backup` refuses to run
   while the lifecycle is on unless told the workers are stopped. Tests: round trip of a database with artifacts; a corrupted file is
   detected by `verify`; an upload made between the dump and the copy leaves a consistent
   backup, and a file removed between them is reported and fails the backup.
3. **Restore and check-restore.** `restore` (worker-heartbeat guard, manifest and checksum
   verification, restores into an empty database or `--replace` with a typed
   confirmation), and `check-restore` (read-only). Tests: restore into a fresh database,
   refused while a heartbeat is recent, missing artifact file reported, a preview whose app
   is gone listed (using the fake Dokku port). The runbook becomes a how-to under
   `docs/`. A repeatable drill script (`docs/` plus a test that runs the same steps on a
   disposable database) records the result.
4. **Package the clients.** Compile CLI, MCP and SDK (and what they depend on); export maps,
   bins, allowlists; CI step that `bun pm pack`s them, installs the tarballs into a temp
   project **outside** the workspace, and runs them under Node and Bun (`--help`, an MCP
   handshake, an SDK call against a built controller). A check that no tarball contains
   `.env`, tests, source maps with secrets or workspace specifiers.
5. **Images.** Controller and worker Dockerfiles, built in CI (build only), with checks:
   non-root user, no secrets in any layer (scan of the build context and history), migrations
   present, healthcheck, container starts and answers its readiness endpoint against a
   service PostgreSQL in CI (this one live check uses the CI database, not Dokku).
6. **Upgrade drill and docs.** Upgrade from the previous tagged version of the test fixture
   (a database dump of the current schema kept as a fixture; later versions add theirs)
   through backup, migrate, restart, and a status check. Docs: install, upgrade, backup,
   restore, local/private management, Cloudflare and Tailscale routing, onboarding,
   API keys, MCP roots and permissions. Update `docs/tooling.md`, `CONTRIBUTING.md` and the
   patterns doc with every new command.
7. **Release machinery.** The cog hook, the dry-run release workflow, API-compatibility
   rules (what counts as a breaking change for the REST API, SDK and MCP tool list), and the
   release checklist. No publishing.

## What is not done here

- Publishing anything, registering a name or scope, creating tags or releases.
- The production Compose stack, host-port selection, TLS ingress, `.env.local` changes and
  cleanup of existing containers and demo data (`docs/plans/production-compose-follow-up.md`).
- Backing up Dokku itself (apps, volumes, certificates) or any preview datastore: Launchpad
  restores its own state and redeploys previews from stored artifacts. Documented as such.
- arm64 images, multi-host workers, runtime logs.
- The deferred items in the milestone 5 follow-up table other than `check-restore`.

## Verify

Clean-machine install from the packed tarballs and image artifacts; Node and Bun;
npm execution outside the workspace; non-root containers; no secrets in tarballs or layers;
upgrade from the previous fixture; backup/restore drill with the in-flight destroy, an
expired restored preview, and a preview whose app is gone.

## Risks and how they are handled

| Risk                                                                   | Handling                                                                                       |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A restore runs under live workers and the lifecycle deletes a live app | Heartbeat guard, documented stop order, `check-restore` read-only, restore never touches Dokku |
| Migrating the wrong way destroys data                                  | Forward-only, backup warning, schema mismatch refuses start, rollback is restore               |
| A secret ends up in a tarball, image or backup                         | Allowlists, layer and tarball scans, backup excludes env files; tests for each                 |
| Packages that work only inside the workspace                           | Install tests outside the workspace on both runtimes                                           |
| Releasing something irreversible                                       | Dry-run workflow only; publishing needs a separate approval                                    |

## Open questions for the user

- Approve or change decisions 1 to 9 (in particular 2: a backup format versus documented `pg_dump` plus `tar`).
- The npm scope and product name remain undecided; slice 4 uses the current `@launchpad/*`
  placeholders, to be renamed in one change when decided.

## Progress

- Slice 1 (migration status and the schema guard): merged (#45).
- Slice 2 (backup): merged (#46).
- Slice 3 (restore, `check-restore`): the commands are built. Two things the slice promised are
  deferred to slice 6, where the upgrade drill is written: the how-to under `docs/` and the
  repeatable drill script (the integration tests already exercise each step against a disposable
  database, but not the whole runbook with Dokku and workers).
- Slice 4 (packaging the clients): `tooling/package-clients.ts` and `tooling/check-packages.ts`,
  the `test:packages` task and a `Packages` CI job (in the gate). Found while building it: the
  declarations had extensionless relative imports that `nodenext` consumers cannot resolve
  (fixed when staging). The SDK and contracts are published as libraries and the CLI and MCP as
  bundled files whose third-party dependencies stay dependencies. Exercised on Bun and the
  current Node LTS (the Node run was first done in a container here; CI is the check that counts).
  `engines` is Node 22.12 or newer, which `commander` 15 requires. The libraries are ESM
  (a `default` export condition lets `require(esm)` work on Node versions that support it). The
  install step runs without lifecycle scripts, with a cache of its own and the `@launchpad` scope
  pointed at nothing, so nothing resolved by name can stand in for a packed tarball. Before
  publishing: the packed READMEs are still developer docs (links into the repository), and the
  manifests have no `license` or `repository`, which wait for the licence and name decisions.
- Slice 5 (images): `containers/controller/Dockerfile` and `containers/worker/Dockerfile` (the
  controller recipe moved from `apps/controller/`), `tooling/check-images.ts` and `test:images`
  (run in the CI integration job). Migrations are now bundled per file
  (`packages/database/scripts/bundle-migrations.mjs`) and the controller build also produces
  `.output/admin.mjs`, so `migrate` runs from the image (slice 1's known limit is closed). Found
  by running the worker image: with deployments off the worker exited at once under Bun (a pending
  promise does not keep it alive), which a restart policy would have turned into a loop; it now
  idles on a timer, with a test.
- Slice 6 (upgrade drill and docs): the frozen 14-migration PostgreSQL fixture and
  `test:upgrade` exercise the built admin command and controller image against disposable
  PostgreSQL (backup, image migration, image restart, authenticated operator status,
  fresh restore). The operator
  install, backup, restore, upgrade, private routing and onboarding how-tos are
  under `docs/`; the restore how-to records the isolated Dokku rehearsal separately.
  An actual remote in-flight destroy is **not** run by CI: it needs the explicitly
  isolated host and is not implied by the database-only test. The whole-runbook
  remote rehearsal is still open and must be recorded before the slice is called
  complete. It is currently blocked on the safety boundary: milestone live tests
  are limited to `lp-test-` apps, but the production preview table only accepts
  `lp-` plus ten characters and the normal Dokku client applies that same
  allowlist. Do not weaken production validation or run the drill with real
  preview names without a separate decision on the disposable-host exception.
