# P2: replace the previews with the immutable model's schema

Status: **revised 2026-11-19 after the user dropped the legacy runtime and after an
independent review of that revision**. Parent plan:
[immutable deployment model](immutable-deployment-model.md). Schema contract:
[replacement schema map](../design/immutable-cutover-schema.md). Nothing here is
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

- **Runbook first.** With the **pre-P2b** binary, take a backup and run `inventory-previews`
  (it lists deleted previews too, which catches failed destroys), then remove any Dokku apps you
  do not want left behind. After 018 the database no longer records them.
- **Migration** exactly as in the schema map: one Kysely migration in the migrator's own
  transaction (it opens none), `SET LOCAL lock_timeout`, one `DROP TABLE` statement for the
  preview tables and `worker_heartbeat` with no `CASCADE`, idempotency rows and
  `lifecycle.enabled_at` deleted, `preview:*` keys revoked with count-only audit, the model
  tables, registries and guards, and the gate initialized to `ready`.
- **Types and readers.** Remove the dropped tables from `Database`, add the model tables;
  `artifact-gc` pins by `immutable_deployment`; `check-restore` reads `immutable_deployment`;
  delete `inventory-previews`, its spec and docs.
- **Recovery gate.** The marker (written after every refusal and the archive pre-check, before
  the first copy, and kept if a restore fails), the database gate, the fail-closed checks scoped
  to model mutations, a missing gate row allowed only while 018 is not recorded, and
  `launchpad-admin recovery-clear`, which in P2b succeeds only when every model table is empty. Empty tables prove nothing about remote state once a writer exists, so the P3 PR that adds the first model writer must replace that rule with verified reconciliation in the same PR, with a test that the old rule is gone.
  Any restore by a binary that knows 018 writes the marker, whatever the manifest holds.
- **Delete the P1 scaffolding:** `immutable-retirement.spec.ts`, `immutable-old-process.spec.ts`,
  `inventory.spec.ts`, the fixtures `immutable-retirement.sql` and `immutable-model.sql`, and the
  tasks `test:cutover:retirement`, `test:cutover:old-process`, `test:cutover:model` and
  `test:inventory`; the integration job's `fetch-depth: 0` (keep the commits job's); and the
  entries in `CONTRIBUTING.md`, `docs/tooling.md` and `docs/patterns/README.md`. Rewrite
  `immutable-model.spec.ts` against the real migration. `packages/alias-router/src/schema.ts`
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

| Risk                                                    | Control                                                                                                                                                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data loss: previews are dropped                         | Decided and stated; backup and inventory with the pre-P2b binary first                                                                                                                                                                                   |
| Dokku apps orphaned                                     | Nothing reports them until P5 wires drift, so the runbook is the control. Before P3 enables deploys, orphans must be removed **or** the P3 worker must treat any app that already exists at create time as a hard failure, never a resume                |
| A removed symbol, route or scope is still referenced    | P2a removes readers first; grep gate; integration against the real migration                                                                                                                                                                             |
| Stored `preview:*` keys between P2a and P2b             | Refused at authentication in P2a; revoked in 018                                                                                                                                                                                                         |
| Interrupted collection before upgrade                   | Stop workers cleanly; `check-restore` reports missing files; P3 worker recovers at start                                                                                                                                                                 |
| Old binary mixed with the new schema                    | Startup check refuses new starts once 018 is recorded; distinct names keep an old process off new rows. Neither stops a running process or an already-dispatched Dokku operation, so the runbook is to stop every old process and let remote work settle |
| Restore leaves the model operable before reconciliation | Marker plus gate, both fail closed, keyed on the binary and not the manifest                                                                                                                                                                             |
| Migration queues a lock behind readers                  | `lock_timeout` for 018 (015 to 017 are not covered when starting from 014)                                                                                                                                                                               |
| Guards are not a privilege boundary                     | Stated in the schema map; the owner and application role split is a **gate** of the production Compose plan                                                                                                                                              |
| `main` cannot deploy for a while                        | Accepted by the user; features are removed cleanly, not left half-working                                                                                                                                                                                |

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
