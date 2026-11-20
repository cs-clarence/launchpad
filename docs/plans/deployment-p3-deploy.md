# P3: deploy and delete one deployment end to end

Status: **approved 2026-11-20 with the numbered decisions below. P3a is built on
`feat/deployment-p3a-attestation`; later slices are not started. Nothing here is authorized to run
against real infrastructure.**
Parent: [deployment model plan](deployment-model.md), P3. Schema contract:
[replacement schema map](../design/deployment-cutover-schema.md). Behavior:
[deployment design](../design/deployment-modes.md). Slices P4 (aliases, promotion, retention
windows) and later are out of scope here.

## Assessment

- **Kind / risk:** Large / High. It introduces the first live writer of the model tables, the
  first worker that touches Dokku since the previews were removed, new API scopes, and guarded
  deletion of remote resources.
- **How much changes:** recovery administration, services, contracts and scopes, API and OpenAPI,
  worker claim/lease/runner, artifact GC callers, integration fixtures and operator docs.
  No dashboard, CLI, MCP or alias work (P4 and P6).
- **Unknowns (riskiest first):**
    1. Claim fencing against a real PostgreSQL lease: a stale worker must write zero rows. Proven
       only by a test that exercises an actual state write.
    2. Allocation races: per-app serialization, quota counting retained remote instances,
       hostname and Dokku-name registries committed with the deployment.
    3. Deletion safety without aliases: P3 has no pins from aliases, but must still refuse deleting
       an unfinished or uncertain deployment and leave P4 a lock order it can extend.
    4. The recovery attestation that replaces the P2b empty-model rule (below).
- **Undo:** before any deployment exists, a revert. After deployments exist, disable new jobs,
  drain and reconcile claims, retain records and resources. A restore never reopens mutations
  without the attestation. No down migration.
- **People / time:** one integrating author, an independent read-only Opus review before every
  nontrivial push, CodeRabbit and CI before merge. Five PRs, each reviewable alone.
- **Excluded:** production startup, DNS, publishing, connector changes, aliases, promotion,
  router calls, retention windows beyond the deadline, dashboard/CLI/MCP clients, and any
  deletion of existing external resources. Real Dokku is not touched in P3 at all; the disposable
  rehearsal stays in the parent plan's P7.

## Decisions this plan makes (change them before approving, not later)

1. **Quotas are enforced** from P3b at the design defaults: `LAUNCHPAD_MAX_APPS` 10 per
   organization, `LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP` 20 and `LAUNCHPAD_MAX_DEPLOYMENTS` 100, counting
   retained instances, failed resources awaiting cleanup and allocations in flight, under the
   quota advisory lock. Refuse at the limit; never delete a target to make room.
2. **A narrow deployment configuration**, not the alias configuration: P3 adds
   `parseDeploymentConfig` (apps domain, `LAUNCHPAD_APPS_PROXY_URL`, templates, `LAUNCHPAD_DEFAULT_TTL`
   / `LAUNCHPAD_MAX_TTL`, the three limits). The alias and router settings in
   `parseAppRoutingConfig` stay required only once aliases exist (P4), so P3 needs no router.
   `parseAppRoutingConfig` is refactored to build on it; its tests keep passing.
3. **`LAUNCHPAD_DEPLOYMENTS=on|off` is the off switch** (the reserved name, default off). Off: the
   API refuses new deployments and deletions with a clear 503-style error, the worker idles, and
   reads still work. Existing keys are neutralized by the switch, not by revoking scopes.
4. **`preview_expires_at`** is set at allocation to `now + LAUNCHPAD_DEFAULT_TTL` (7d; a request
   may ask for less, never more than `LAUNCHPAD_MAX_TTL`). It is only a deadline in P3: scheduled
   expiry is **out** of P3, manual deletion only.
5. **Single claimer is not assumed.** The fencing tests run concurrent claimers; deployment is
   still one worker process in practice.
6. **Upload route:** `POST /projects/{projectId}/artifacts` under `app:deploy`, with the previous
   limits and project-access checks. The old unscoped path is not restored.
7. **Interim reconciliation path:** a `reconciliation-needed` deployment blocks its app (the
   unfinished-per-app index covers it by design). P3 adds an operator-only admin command,
   `deployment-reconcile`, audited and count-only, that records an observed outcome (`succeeded`,
   `failed-clean` or `abandon`) after the operator verified Dokku by exact name; it never destroys
   or creates remote resources. The session-only authorized path stays P4/P5.
8. **Real Dokku is not part of P3.** The disposable-Dokku rehearsal stays in the parent plan's P7;
   P3e uses a fake Dokku/Docker adapter in CI and documents the commands.

## Worked acceptance example

Organization O, project P. Create app W. Upload artifact X once. Deploy twice (A, B): two
deployment rows, two opaque Dokku names (`lp-` plus ten characters), two unique hostnames, one
image identity each recorded after build; neither reuses the other's remote app. A deploy of a
failing artifact (C) ends `failed` having touched only C's own resources; A and B are untouched
and C never reloads an earlier target. Delete B: its Dokku app and exact-tag images are removed,
the row stays soft-deleted, its hostname and name stay reserved forever. Deleting an unfinished or
reconciliation-needed deployment is refused. Two simultaneous deploys to W: exactly one is
accepted. A worker that lost its lease mid-build and then writes finishes with zero rows changed.
Restore the database: model mutations are refused until the operator attestation is recorded.

## Ordered delivery

### P3a: recovery attestation (before any writer exists)

Implement the schema map's **interim rule**: `recovery-clear` stops consulting `model-writer-seen`
and the model tables (a replaced volume loses the file, and empty tables cannot be told from a
never-used installation) and **always** refuses unless the operator passes
`--i-have-reconciled-router-and-dokku`. The flag attests the four ordered steps in the schema map
(closed ingress and settled dispatched Dokku work; rotated router epoch and credentials when a
router is in use; reconciled router and Dokku against the restored database; then clear). An audit
event records only counts and the attested items. Ordering is unchanged: commit the ready gate and
audit, then remove the marker. It still refuses while an import record is pending.
Artifact GC already runs under `withModelMutation` and so already records `model-writer-seen`; the
new tests expect that and prove the file no longer matters. Rewrite the P2b tests (rule gone;
refuses without the flag on a database with rows, on an empty one, and with the file absent),
and update `docs/restore.md` and the design. P4 and P5 extend the attestation.

Checks: services integration tests (no flag, flag, audit contents, marker ordering after a crash),
controller restore tests. Undo: revert; no schema change.

### P3b: apps and deployments through services and API (enqueue only)

Split into two PRs. **P3b-i (services, built):** migration 019, scopes, `parseDeploymentConfig`,
app and deployment services and their tests; nothing is routed yet. **P3b-ii (API):** the routes,
upload endpoint and its body framing, response schemas, OpenAPI and the built-server tests.
The dashboard key form (`api-keys.tsx`) does not offer the new scopes until P6; keys carry them
via the API. Provenance is a table, not a column: artifacts are deduplicated by digest, so one artifact can be
uploaded through several projects, and `artifact_project(artifact_id, project_id)` records each.

- Contracts and scopes: add `app:read`, `app:deploy`, `app:delete` to `API_KEY_SCOPES`; `app:promote`
  and `app:alias:manage` arrive with P4. Roles per the permission matrix (read: viewer; create app,
  deploy, extend: deployer; delete: deployer). Keys still need the creator's current role and
  project access. Unknown scopes are rejected at issuance as today.
- Services (framework-free, every function takes the principal and organization, non-members get
  not-found): `createApp`, `getApp`, `listApps`, `createDeployment`, `getDeployment`,
  `listDeployments`, `listDeploymentEvents`. Writes run inside `withModelMutation`.
  `createApp` takes the quota advisory lock for `LAUNCHPAD_MAX_APPS`. `createDeployment` locks in
  the schema map's order (quota advisory lock, app row), checks the artifact belongs to the
  organization and is stored **and that the caller may use it**, in the same locked transaction as
  the other checks: the app's project must be one the key can access, and artifacts are
  organization-owned and carry no project today, so P3b adds forward migration 019: the
  `artifact_project` table (qualified FKs to `artifact` and `project`, one row per project an
  artifact was uploaded through, written by the upload service). A key with a project restriction
  may deploy only an artifact with a row for the app's project, **regardless of creator**; an
  artifact with no rows (older ones) is refused for such keys. Keys without a restriction and sessions need only the organization match
  and the role. Tests: two keys with the same creator, one restricted to project A and one to B,
  against an artifact uploaded through B (the A key is refused, the B key succeeds, an
  unrestricted key succeeds), and a null-provenance artifact refused for a restricted key, enforces the per-app unfinished rule and both deployment quotas,
  generates the Dokku name and hostname (`hostname-template.ts`), sets `preview_expires_at` per
  decision 4, inserts the deployment and its two reservation rows in one transaction, and records
  the first `app_deployment_event` (`queued`) in the same transaction. No network I/O inside a
  transaction. Nothing executes the job yet. The `LAUNCHPAD_DEPLOYMENTS` switch gates writes.
- Events: the service writes the `queued` event; the worker writes the rest (phases and fixed
  bounded messages only, never remote output). Each event has the next `seq` under the
  deployment's own fence.
- Upload and API: `POST /projects/{projectId}/artifacts`, `POST /projects/{projectId}/apps`, app
  reads, `POST /apps/{id}/deployments`, deployment reads and events, all under the new scopes.
  OpenAPI from the zod schemas. Any counter that appears in a response is a decimal string.

Checks: authorization matrix and project-restriction tests, allocation and quota races on
PostgreSQL (apps, per-app, per-organization, unfinished-per-app), reservation reciprocity,
switch-off behavior, built-server HTTP test, OpenAPI parity. Undo: set `LAUNCHPAD_DEPLOYMENTS=off`;
queued rows are inert; or revert.

### P3c: worker claim, lease and deploy runner

- Claim: `FOR UPDATE SKIP LOCKED` on the oldest runnable deployment, setting owner, attempt, fence
  and a five-minute lease; heartbeat extends it. Every state write includes deployment ID, attempt,
  fence and a live lease in its `WHERE`, so a reclaimed job's old worker updates zero rows.
- **Time bounds and lease loss.** Every Dokku and Docker call has a deadline that ends strictly
  inside the current lease, and a failed or late heartbeat aborts the shared signal. A call that hits its deadline while the lease is still valid is resolved by what is proven:
  a **local** step (the Docker build) is `failed` only after the worker killed the process and
  observed its exit; any **remote** call (Dokku over SSH, image load) whose outcome is not
  confirmed becomes `reconciliation-needed`, exactly as for a lapsed lease. A deployment is never
  marked `failed` while remote work may still be running. Tests cover a build killed at the
  deadline (`failed`, exit observed) and a Dokku call timing out mid-flight (`reconciliation-needed`). Every claim and every
  remote effect first calls `recordModelWriterSeen` and re-checks the recovery gate, not only a
  startup check. A check cannot make dispatch atomic, so the protocol is two layers: a watchdog
  re-reads the gate on a short interval and aborts the shared signal when it closes (in-flight
  calls end at their own deadline, at most one call per worker can finish after closure), and the
  restore/clear attestation already requires every writer to be stopped and every dispatched
  operation settled before reopening. The race is **bounded and accepted, not eliminated**: a call may start after the gate closes but before the watchdog notices (at most one watchdog interval, configurable and short). The guarantee is that no call starts after the watchdog has detected closure, and that every writer is stopped by the operator before a restore proceeds. The test therefore closes the gate between a check and its dispatch with a deliberately delayed watchdog, asserts the in-flight call is still resolved by the timeout rule (`failed` or `reconciliation-needed`), and asserts no further call starts after detection. If no call may ever start after closure, that needs synchronization between closure and dispatch and is out of P3.
- **Reclaim by recorded step** (migration 018's `step_done`/`step_pending`):
    - nothing remote was pending: resume from `step_done`;
    - a remote step was pending when the lease lapsed (create, build, load): the outcome is
      unknown, so the deployment becomes `reconciliation-needed` and is never retried or adopted
      as success;
    - an app this deployment already recorded is its own, not "pre-existing".
      Only an app that exists at create time **with no recorded ownership by this deployment** is a
      hard failure.
- Runner: for the claimed deployment only: create its fresh Dokku app, set domain and port, build,
  record image tag and image ID, load, verify through the unique hostname, record `succeeded`.
  Failure removes only the resources this deployment recorded and marks `failed`. No rollback or
  reload of any other deployment: delete the `rollback` method from `DeployPorts`
  (`apps/worker/src/types.ts`, `ports.ts`), `rollback.spec.ts` and its use in `live.spec.ts`.
- Worker composition: opens the database again (dropped in P2a), reads `parseDeploymentConfig`,
  the Dokku settings and the data directory, honors `LAUNCHPAD_DEPLOYMENTS`, and keeps the idle
  health marker semantics when off.

Checks: PostgreSQL queue and reclaim tests per step above, the real-adapter stale-claim test (a
delayed write after reclaim changes zero rows), lease-bounded deadlines and heartbeat-failure
abort, gate-closed-mid-run stops dispatch, two deployments with distinct remote identities,
failed candidate leaves siblings untouched, adapter tests with fake Dokku and Docker. Undo:
`LAUNCHPAD_DEPLOYMENTS=off`, stop workers, reconcile claims; retain records.

### P3d: guarded deletion, reconciliation and artifact pins

- Services: `requestDeploymentDeletion` (deployer, `app:delete`) under the app lock; refuses
  unfinished, `reconciliation-needed` and already deleting deployments. It inserts the
  `deployment_deletion_operation` and sets `desired_state` to `deleting`. Manual deletion works
  because scheduled retention does not exist in P3. P4 adds alias and promotion pins to the same
  guard and lock order.
- Worker deletion runner: claims with its own fence and the same time-bound and gate rules as
  deploy, destroys the exact recorded Dokku app and removes exact-tag **local** images (the tags
  recorded on the deployment; the worker builds and loads locally, and `loadImage` already
  removes the local tag after loading, so this covers only what a failed build left), treats an
  absent remote app as done only after an existence read, and finalizes `deleted` with
  `deleted_at`. A destroy whose outcome is uncertain stays reconcilable. Finalizing never sets a
  reservation's `released_at`: hostnames and names stay reserved permanently, as the schema map
  requires.
- API: `DELETE /deployments/{deploymentId}` returns 202 with the operation ID. It needs the
  `app:delete` scope and the deployer role, the app's project access for restricted keys, and is
  refused while `LAUNCHPAD_DEPLOYMENTS` is off. Reads expose the deletion state. OpenAPI from the
  zod schemas. Clients stay out of P3.
- `deployment-reconcile` admin command (decision 7), audited, counts only.
- Artifact GC already pins deployments, and already runs under `withModelMutation`; add tests
  against retained, deleting and deleted rows and the new states.

Checks: the delete route's scope, role, project-restriction and switch-off matrix, deletion races with deployment creation and with GC pin checks, crash after destroy,
absent-then-present remote app, exact-tag image removal, reservation permanence, reconcile
command outcomes, the blocked-app case unblocked by `deployment-reconcile`. Undo:
`LAUNCHPAD_DEPLOYMENTS=off`; rows stay `deleting` and resume later.

### P3e: end-to-end acceptance and documentation

Built controller and worker against disposable PostgreSQL with a fake Dokku and Docker adapter (no
real Dokku, no service start beyond the test containers). Update install, upgrade, restore,
tooling, patterns, the controller and worker READMEs, the example environment and examples with
real commands, including `LAUNCHPAD_DEPLOYMENTS`. The disposable-Dokku rehearsal remains the
parent plan's P7 and needs its own authorization.

Checks: full local gate, image, upgrade and package gates; Opus review; CodeRabbit and CI. Undo:
revert, or `LAUNCHPAD_DEPLOYMENTS=off`.

## Risks

| Risk                                                 | Control                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| First writer reopens a restored database             | P3a lands before any writer; writer-seen is set before the first effect; attestation is unconditional once a writer has run    |
| Stale worker finalizes after reclaim                 | Every write carries attempt, fence and a live lease; an actual-write test, not only a status check                             |
| Worker adopts or destroys a resource it does not own | Fresh opaque names; existing app is a hard failure; deletion by exact recorded name; reservations permanent                    |
| Quota or per-app races over-allocate                 | Quota advisory lock then app row; races tested on PostgreSQL                                                                   |
| Remote outcome mistaken for success                  | Uncertain becomes `reconciliation-needed`; never auto-retried or auto-destroyed                                                |
| Key privilege escalation                             | Explicit new scopes, no mapping from old ones, role and project checks retained                                                |
| Lock order diverges before P4                        | Order documented in the services and tested; P4 only adds aliases and operations to it                                         |
| Reclaim adopts or fails on its own app               | Reclaim is defined by recorded step: resume, `reconciliation-needed`, or own app; only unowned existing apps are hard failures |
| `reconciliation-needed` blocks an app indefinitely   | Operator-only `deployment-reconcile` in P3d; session path in P4/P5                                                             |
| Worker outlives its lease or the gate                | Per-call deadlines inside the lease, heartbeat-failure abort, gate and writer-seen re-checked per effect                       |
| Real infrastructure touched                          | Not in P3; fake adapters only. The Dokku rehearsal is P7 with its own authorization                                            |

## Open questions for the user

None block P3a. Confirm or change the numbered decisions above before P3b (quotas, narrow
configuration, the `LAUNCHPAD_DEPLOYMENTS` switch, TTL, upload route and `deployment-reconcile`).

## Verification and approval

Each PR: `omni -i run check test build`; integration, image, upgrade and package gates where
touched; disposable PostgreSQL only (stop it afterwards); independent read-only review before each
push; CodeRabbit and CI before merge. Awaiting approval of this plan before P3a starts.
