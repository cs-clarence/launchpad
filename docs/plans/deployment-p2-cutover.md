# P2: replace the previews with the immutable model's schema

Status: **revised 2026-11-19 after the user dropped the legacy runtime and after an
independent review of that revision**. Parent plan:
[immutable deployment model](deployment-model.md). Schema contract:
[replacement schema map](../design/deployment-cutover-schema.md). Nothing here is
authorized to run against a real installation.

## Decisions (user, 2026-11-19)

1. **Retire first**: `main` may be unable to deploy between P2 and P3.
2. **Replace, do not retire**: keep no legacy runtime. No `410` stubs, no `legacy_*`
   history, no retirement guard, no old-process fencing, no backup floor.
3. **Drop the preview data unconditionally** in the migration. It does not refuse and does
   not touch Dokku, so the operator removes any remaining apps by exact name.

These supersede the P1 retirement specification (PR #55). The verified table contracts,
guards and registry rules carry over; the retirement SQL, the old-process drill and their
scaffolding are deleted in P2b.

## Assessment

- **Kind / risk:** Large / High. It removes the only way to deploy, drops data, and changes
  the schema, authorization, restore, status contract and configuration.
- **Undo:** before the migration runs anywhere, revert. After it the preview data is gone by
  design; recovery is a matched pre-upgrade backup with the previous binary under closed
  ingress, never a down migration.
- **Would raise it:** keeping legacy history, or an installation with previews worth keeping.

## Goal and done means

After P2 the preview tables and `worker_heartbeat` are gone; the model tables exist, empty and
guarded; no code reads or writes a removed table; the preview API, pages, SDK methods, CLI
commands, MCP tools and contracts are removed rather than stubbed; an old binary is refused at
startup once 018 is recorded; a restore leaves model mutations blocked until a verified
recovery; and obsolete configuration fails with an actionable error. Out of scope: any model
behaviour (P3 onwards), the new client UX (P6), the production Compose stack and DNS.

## Order: code first, schema second

Nothing outside TypeScript touches the preview tables by name, so removing readers first
leaves them harmlessly unused and `main` consistent at each step.

### P2a: remove the legacy runtime (schema untouched)

**API and UI.** Delete the preview, deployment and deletion routes, their idempotency
handling, their OpenAPI entries and the artifact upload endpoint (it is gated by
`preview:deploy`, and P3 reintroduces it under `app:deploy`). Removed routes are not
registered. Delete the preview pages, `lib/previews.ts`, `lib/deploy-flow.ts`,
`components/deploy-panel.tsx`, the links in `routes/orgs.$orgId.tsx`, the server functions in
`server/data.ts` that call the services directly, and remove the preview scopes from
`components/api-keys.tsx`.

**Services.** Delete `previews`, `deployments`, `deletions`, `expiry`, `lifecycle-run`,
`lifecycle` and their specs. Things that survive them and where they go:

- `LIFECYCLE_AUDIT.artifactCollected` is used by `artifact-gc`: define that one audit action
  inside `artifact-gc`.
- `DeployPorts`, `DeployContext` (from `deployments.ts`) and `LifecyclePorts` (from
  `deletions.ts`) are used by `apps/worker/src/{ports,build,lifecycle-ports}.ts`: move them
  into the worker (`apps/worker/src/types.ts`), where P3 will redefine them.
- `deploymentsEnabled` and the lifecycle flags are deleted, not moved.
- Kept for P3 to P5: `drift` (pure), `hostname-template`, `app-routing-config`, `archive`,
  `artifacts`, `artifact-config` and `artifact-gc` (which still reads the preview tables until
  P2b and has no caller, so uploaded archives are not collected between P2 and P3).

**Worker.** Always idle: health marker only, no database, no Dokku settings required. Log one
`legacy-runtime-removed` event. `recordHeartbeat` and `recoverInterruptedCollections` lose
their only callers; the second leaves a risk that a collection interrupted _before_ the
upgrade leaves an archive moved aside. Accepted in writing: the runbook says to stop workers
cleanly first, `check-restore` already reports missing archive files, and the P3 worker calls
it again at start. Update `idle.spec.ts` and `tooling/check-images.ts:385` (which looks for the
`disabled` event). The Docker and Dokku modules stay, with their specs, for P3; `config.ts`
loses its imports of the removed flags.

**Controller runtime and status.** Rewrite `runtime.ts`: drop `previewSettings`, the
`deploymentsEnabled` guard and the data-directory creation it gates. The same-site check only
ran when deployments were on, so the default installation had no such protection and removing
it is not a regression; P3 wires protection from `LAUNCHPAD_APPS_DOMAIN` when deployments exist.
`getStatus` and the status route report instance and migration state only, so the status
contract in `packages/contracts` loses `deploymentsEnabled` and `lifecycleEnabled`. That is a
published SDK contract: record it in the release notes.

**Backup and restore messages.** Remove the lifecycle-on refusal in `backup.ts` and the live
worker-heartbeat refusals in `backup.ts` and `restore.ts` (they would pass vacuously once nothing
writes heartbeats), keep the explicit confirmation flag, and rewrite the wording. `main.ts` no
longer passes a lifecycle setting. Delete `admin/live/restore.live.ts` and its task: it rehearsed
previews and is replaced by the P7 rehearsal.

**API-key scopes.** Stop issuing the four `preview:*` scopes. A key holding any scope outside the
current set is **refused at authentication** (fail closed), so stored keys cannot work between P2a
and P2b; migration 018 then revokes the rows.

**Clients and docs.** Remove the preview methods, commands, tools and schemas, with their specs
and READMEs, from `packages/sdk`, `packages/client-core` (`previews`, `deploy`, `workspace`),
`apps/cli`, `apps/mcp` (`server`, `program`) and `packages/contracts`. Update both
`.env.local.example` files, the controller and worker READMEs, and `install`, `upgrade`,
`restore`, `backup`, `access`, `onboarding`, `releasing`, `tooling` and `patterns/README`.
Record the breaking client changes for the release notes and version policy in `releasing.md`.

**Kept until P2b:** `inventory-previews`, `check-restore` and the preview `Database` types.

Checks: full gate; controller integration (including `hop.spec.ts`) on disposable PostgreSQL;
`test:images`; the upgrade drill (schema unchanged); a grep gate for every removed symbol, route
and scope string across `apps`, `packages`, `tooling` and `docs`.

### P2b: migration 018 and what must move with it

- **Runbook first.** Stop every old controller, worker and admin job and wait for dispatched Dokku operations to settle (at least the 25-minute worker stop grace, then confirm no worker-started `docker`/`dokku` process remains on the host; see the settling rule in the schema map). With the **pre-P2b** binary, take a backup and run `inventory-previews`
  (it lists deleted previews too, which catches failed destroys), then remove any Dokku apps you
  do not want left behind. After 018 the database no longer records them.
- **Migration** exactly as in the schema map: one Kysely migration in the migrator's own
  transaction (it opens none), `SET LOCAL lock_timeout`, one `DROP TABLE` statement for the
  preview tables and `worker_heartbeat` with no `CASCADE`, idempotency rows and
  `lifecycle.enabled_at` deleted, `preview:*` keys revoked with count-only audit, the model
  tables, registries and guards, and the gate initialized to `ready`.
- **Types and readers.** Remove the dropped tables from `Database`, add the model tables;
  `artifact-gc` pins by `deployment`; `check-restore` reads `deployment`;
  delete `inventory-previews`, its spec and docs.
- **Recovery gate.** The marker (written after every refusal and the archive pre-check, before
  the first copy, and kept if a restore fails), the database gate, the fail-closed checks scoped
  to model mutations, a missing gate row allowed only while 018 is not recorded, and
  `launchpad-admin recovery-clear`, which in P2b succeeds only when every model table is empty **and** the durable `model-writer-seen` file (created and fsynced by the first writer **before** its first mutation or remote side effect, outside the dump, failing closed if it cannot) does not exist. Empty tables prove nothing about remote state once a writer has run, so the P3 PR that adds the first writer replaces that rule with an interim fail-closed rule that does not consult the file or the tables (a volume replacement removes the file, and empty tables cannot be told from a never-used installation): `recovery-clear` always refuses unless the operator gives an explicit, audited `--i-have-reconciled-router-and-dokku` attestation, which covers closing ingress, rotating the router epoch and credentials, and reconciling router and Dokku (see the schema map). P4 adds a router-read counter check and a monotonic `recovery-raise-counters` step. Verified reconciliation is P5, and replaces the attestation. Rolling back to a P2b binary after P3 has written is unsupported.
  Any restore by a binary that knows 018 writes the marker, whatever the manifest holds.
- **Delete the P1 scaffolding:** `immutable-retirement.spec.ts`, `immutable-old-process.spec.ts`,
  `inventory.spec.ts`, the fixtures `immutable-retirement.sql` and `immutable-model.sql`, and the
  tasks `test:cutover:retirement`, `test:cutover:old-process`, `test:cutover:model` and
  `test:inventory`; the integration job's `fetch-depth: 0` (keep the commits job's); and the
  entries in `CONTRIBUTING.md`, `docs/tooling.md` and `docs/patterns/README.md`. Rewrite
  `deployment-model.spec.ts` against the real migration. `packages/alias-router/src/schema.ts`
  is a false positive: leave it.
- **Drills.** The frozen schema-014 upgrade drill migrates to 018 and asserts the preview tables
  and `worker_heartbeat` are gone; a post-018 backup round trip; an older dump restored over a
  database holding model rows writes the marker.

Checks: the verification list in the schema map and an independent review of the migration before
it is pushed.

### P2c: configuration break

Refuse `LAUNCHPAD_PREVIEW_DOMAIN`, `LAUNCHPAD_PREVIEW_PROXY_URL`, `LAUNCHPAD_MAX_PREVIEWS`,
`LAUNCHPAD_ALLOW_NO_EXPIRY` and the lifecycle names (`LAUNCHPAD_LIFECYCLE*`) with an actionable
error, and enforce the apps-domain separation from the management origin. Wire **only** those
refusals and the domain check: the full `app-routing-config` parser would make the controller
require router settings that nothing uses until P3. `LAUNCHPAD_DEPLOYMENTS` stays a reserved name
(the idle log says deployments are unavailable). Update examples, Compose tasks and docs.
Independent of the schema; it may land before P2b.

## Risks

| Risk                                                    | Control                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data loss: previews are dropped                         | Decided and stated; backup and inventory with the pre-P2b binary first                                                                                                                                                                    |
| Dokku apps orphaned                                     | Nothing reports them until P5 wires drift, so the runbook is the control. Before P3 enables deploys, orphans must be removed **or** the P3 worker must treat any app that already exists at create time as a hard failure, never a resume |
| A removed symbol, route or scope is still referenced    | P2a removes readers first; grep gate; integration against the real migration                                                                                                                                                              |
| Stored `preview:*` keys between P2a and P2b             | Refused at authentication in P2a; revoked in 018                                                                                                                                                                                          |
| Interrupted collection before upgrade                   | Stop workers cleanly; `check-restore` reports missing files; P3 worker recovers at start                                                                                                                                                  |
| Old binary mixed with the new schema                    | Startup check refuses new starts once 018 is recorded. The replacement `deployment` table reuses the name, so names do not fence running old code. Stop every old process and let remote work settle before migration                     |
| Restore leaves the model operable before reconciliation | Marker plus gate, both fail closed, keyed on the binary and not the manifest                                                                                                                                                              |
| Migration queues a lock behind readers                  | `lock_timeout` for 018 (015 to 017 are not covered when starting from 014)                                                                                                                                                                |
| Guards are not a privilege boundary                     | Stated in the schema map; the owner and application role split is a **gate** of the production Compose plan                                                                                                                               |
| `main` cannot deploy for a while                        | Accepted by the user; features are removed cleanly, not left half-working                                                                                                                                                                 |

## Open questions

1. **Surviving helpers** (`drift`, `hostname-template`, `app-routing-config`, `artifact-gc`,
   archive code, the Docker and Dokku modules): kept for P3 to P5. Confirm none is dead weight
   before P3 starts.
2. **Heartbeat for P3:** the table is dropped here and P3 designs its own with the worker.

## Verification and undo

Each PR: `omni -i run check test build`; integration, image, upgrade and package gates where
touched; independent read-only review before each push; CodeRabbit and CI before merge. Undo for
P2a and P2c is a revert. Undo for P2b after it has run anywhere real is the matched backup and
previous binary. No step starts production services, publishes, or touches DNS or connectors.

## P2a as built

Deviations from the plan above, and the client-facing breaks for release notes.

- The status contract is reduced to `generatedAt`, `dependencies.database`, `artifacts` and
  `warnings`; it carries no migration state.
- `apps/worker/src/config.ts` is deleted, and the worker no longer depends on the database package.
  The worker's port types moved to `apps/worker/src/types.ts`.
- Backup lost its worker/lifecycle refusal and the `--i-have-stopped-the-workers` flag; restore keeps
  the flag with new wording. Restore retains the legacy heartbeat checks before restore and before
  the schema swap: a populated target with a heartbeat in the last minute is refused even with the
  confirmation flag. These checks go away when P2b drops `worker_heartbeat`.
- `launchpad.json` no longer accepts `name`. CLI exit codes 7 and 8 are reserved for the app deploy
  command.

Breaking, for the release notes: the `preview:*` key scopes, the `/previews`, `/deployments`,
`/deletions` and `/artifacts` endpoints, the SDK `artifacts`, `previews`, `deletions` and
`deployments` clients and `uploadTimeoutMs`, the CLI `deploy`, `previews` and `deployments` commands,
and the MCP `list_previews`, `get_preview`, `list_deployments`, `get_deployment`,
`deployment_events`, `preview_deletion`, `deploy` and `delete_preview` tools and `--allow-*` options.

## P2b progress

Branch `feat/immutable-p2b-schema-recovery`, based on P2a merge `24c0324`.
Implementation complete and independently reviewed locally; pending PR gates.
Nothing here authorizes running the cutover against an installation.

- Migration 018 now replaces the preview tables unconditionally, clears replay/lifecycle
  state, revokes exact `preview:` prefixes with count-only audit, creates the eight guarded
  model tables and initializes the ready gate. The P1 model SQL moved into the migration;
  there is no second fixture copy.
- The model tests use the real migration. Separate cutover tests cover populated 014/017
  upgrades, session/artifact preservation, mixed/unknown/case-variant/already-revoked keys,
  unexpected dependencies and lock-timeout rollback.
- Initial read-only Opus review found no blockers/majors. Follow-up adds the missing immutable
  promotion idempotency key, documents service-owned deletion progression, and shares the
  migrator factory with test setup.
- The [pre-cutover operator runbook](../deployment-cutover.md) records the pre-P2b inventory,
  backup, exact-name app cleanup and remote-operation settling requirements.
- `Database` now describes only the surviving/new tables. Artifact-GC pins immutable
  deployments and gates collection/sweeps; `check-restore` reports deployment IDs/deadlines.
- The fsynced external recovery marker is written before the first archive copy, based on
  this binary's knowledge of 018 rather than the dump. Restore blocks/verifies the database
  gate when its table exists; 018 preserves an older restore's blocked row. Model mutation
  wrappers record/fsync writer-seen before callbacks and hold a shared recovery lock.
  Restore/clear hold the exclusive lock through filesystem changes. Core administration
  stays outside the model gate.
- P2b `recovery-clear` checks every model table under locks and refuses writer-seen even
  after an older dump erased model rows. P3 must replace that rule with the audited
  attestation before adding a live writer; rollback from P3 to P2b remains unsupported.
- P1 inventory, old-process/retirement tests, fixtures and tasks are removed. The dedicated
  focused task is now `test:deployment-schema`; integration no longer requires full Git history.
- Local checks, unit tests, build and all-project integration pass. Disposable image/package
  checks and the image-based schema-014 upgrade/restore drill pass. Restore coverage includes
  post-018 round trip, 014-over-model replacement, 017 blocked-row preservation and killing
  the test's own admin process after import but before its gate write.

Final read-only Opus review of the combined schema/recovery/readers diff found no blockers
or majors. Minor follow-ups clarify OS-user ownership, conservative no-op GC writer records
and missing-storage errors. The final full local gates, image/package checks and image upgrade
drill pass after those follow-ups; disposable PostgreSQL is torn down.

PR #58 is open; original head passed all eight checks. Review follow-ups below
are pending refreshed PR gates.

PR #58 review follow-up: the user chose a durable importer refusal guard rather
than an importer-held process-lock redesign. A crashed/unproven `pg_restore` keeps
its external in-progress record, blocking another restore and recovery-clear until
an explicit, durably audited importer-exit acknowledgement. Parent-directory fsync
is repeated after EEXIST, deadline-bearing recovery-lock waits are abortable, and
runbook inventory/cleanup is ordered before 018 but after verified backup.
Independent Opus review found no blockers; its wrapper-contract concern is
addressed by requiring synchronous exec/wait and PGAPPNAME forwarding, with
fire-and-forget wrappers unsupported. Minor follow-ups preserve both import/exit
errors, validate record metadata, cancel archive copying, clarify conservative
backend refusals and audit attestation semantics. Full local checks, tests,
build/integration, image/package checks and the image upgrade drill pass;
disposable PostgreSQL is torn down.

## P2c as built

Branch `feat/deployment-p2c-config`, based on the P2b merge `f07d3bc`.

- `assertCurrentSettings` (`packages/services/src/app-routing-config.ts`) runs from a Nitro startup plugin
  (`apps/controller/src/server/startup-settings.ts`), before the controller accepts requests; the worker runs only `assertNoRemovedSettings`, imported from the dependency-free
  sub-path `@launchpad-kit/services/removed-settings` so the idle bundle stays small (the whole
  barrel grew it from about 1.5 KB to 475 KB). Together they refuse `LAUNCHPAD_PREVIEW_DOMAIN`, `LAUNCHPAD_PREVIEW_PROXY_URL`,
  `LAUNCHPAD_MAX_PREVIEWS`, `LAUNCHPAD_ALLOW_NO_EXPIRY` and any non-empty `LAUNCHPAD_LIFECYCLE*` name,
  and the controller, when `LAUNCHPAD_APPS_DOMAIN` is set, checks the domain pattern and its registrable-domain
  separation from `LAUNCHPAD_BASE_URL`. An empty value counts as unset.
- It does not call `parseAppRoutingConfig`, so no router, proxy or alias setting is required.
  `LAUNCHPAD_DEPLOYMENTS` stays reserved and unread.
- Undo is a revert. Breaking, for the release notes: a deployment that still sets a removed name
  now fails at startup; remove the name.
