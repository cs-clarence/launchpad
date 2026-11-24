# Deployment schema

The v1 baseline creates this schema in an empty PostgreSQL database.

## Physical table map

All timestamps are `timestamptz`; IDs are UUID except the existing organization and
user IDs (`text`). Every resource has an organization-qualified unique key for use in
foreign keys, and all references are `ON DELETE RESTRICT`, never cascade. Actor
references point to the existing user table.

Explicit composite keys and FK targets:

- `app`: `UNIQUE(organization_id,id)` and `UNIQUE(organization_id,project_id,id)`; its
  project FK is `(organization_id,project_id) → project(organization_id,id)`.
- `app_alias`: `UNIQUE(organization_id,app_id,id)`; the promotion alias FK references
  that exact triple.
- `deployment`: `UNIQUE(organization_id,id)` and
  `UNIQUE(organization_id,app_id,id)`; deletion's FK uses
  `(organization_id,app_id,deployment_id)`, as do alias and promotion targets.
- `promotion_operation`: `UNIQUE(alias_id,id)` supports nullable
  `(alias_id,supersedes_operation_id)` and `(alias_id,superseded_by_operation_id)`
  self-FKs. Same-alias membership implies same app and organization. Reciprocal and
  acyclic supersession remain service checks.

| Table                           | Required fields / constraints                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`                           | `id`, `organization_id`, `project_id`, `slug`, `state` (`active`, `shutting-down`, `deleted`), actor/timestamps; qualified project FK, unique `(organization_id,id)`, partial live `(project_id,slug)` uniqueness                                                                                                                                                                                                         |
| `deployment`                    | `id`, org/app/artifact, fixed `spa`, permanent `app_name`/`hostname`, job status, `attempt`, lease owner/expiry, done/pending step, image tag and image ID, fixed failure fields, requester/timestamps, required `preview_expires_at`, nullable `last_unpinned_at`, deletion state/timestamp; qualified app/artifact FKs; unique `(organization_id,app_id,id)`; no preview ID, active-deployment pointer or rollback step |
| `app_deployment_event`          | identity bigint PK, org/deployment, positive `seq`, phase, level, bounded fixed message, timestamp; FK `(organization_id,deployment_id)` to `deployment`; unique `(deployment_id,seq)`                                                                                                                                                                                                                                    |
| `app_alias`                     | ID/org/app/slug, permanent hostname, state from design, nullable committed target, nonnegative bigint `reserved_generation` and `committed_generation`, actor/timestamps; committed ≤ reserved; target FK `(organization_id,app_id,target_deployment_id)`; live slug unique per app; positive generation on bound state                                                                                                   |
| `promotion_operation`           | ID/org/app/alias, action, previous/desired target, expected generation, allocated generation, status, attempt/fence/lease, done/pending intent, actor/idempotency/timestamps, safe outcome details, supersedes/superseded-by; bind requires desired target; withdraw requires null desired target; same-app/org alias and target FKs; unique `(alias_id,generation)`                                                      |
| `deployment_deletion_operation` | ID/org/app/deployment, reason (`manual`, `expired`, `shutdown`), status, attempt, independently monotonic fence, lease, done/pending destroy/images step, requester and timestamps; qualified deployment FK; unfinished unique per deployment                                                                                                                                                                             |
| `hostname_reservation`          | permanent hostname PK, kind/owner/org, created/released timestamps, owner uniqueness and deferred reciprocal triggers                                                                                                                                                                                                                                                                                                     |
| `dokku_name_reservation`        | permanent opaque app-name PK, kind/owner/org, created/released timestamps, owner uniqueness and deferred reciprocal triggers                                                                                                                                                                                                                                                                                              |

The unfinished-deployment index is on `app_id` for `queued`, `preparing`,
`building`, `deploying`, `verifying`, `reconciliation-needed`.
New terminal status never authorizes an in-place redeploy. Deletion has its own
state and does not rewrite a succeeded deployment's immutable identity/settings.
The unfinished promotion index covers unfinished operations only when
`superseded_by_operation_id IS NULL`; links are qualified to the same alias.
No clock-dependent SQL index predicate. Generation strings remain decimal in JS;
positive values are bounded by PostgreSQL bigint max and never recycled.

Eligibility/pins cannot be implemented by FKs alone. Allocation takes the org quota
lock before the app lock. Every pin reservation, finalization, correction and GC
decision takes app, ordered aliases, ordered deployments, then operation locks.
Operations reference previous/desired targets through the full unresolved chain.
These requirements become service/SQL integration tests, not merely this map.
Likewise, the service requires deletion to enter `deleting` and complete its deletion operation
before recording `deleted`; the schema prevents reversal/reactivation but does not prove the
remote destroy occurred. A promotion records its immutable `idempotency_key` on the operation;
the shared `idempotency_key` table binds replay to organization, principal and endpoint.

## Permanent identity registries

`hostname_reservation` and `dokku_name_reservation` hold every hostname and Dokku app
name ever allocated. Owners are `deployment` or `alias` for hostnames and `deployment`
for Dokku names (an alias owns no Dokku app). `released_at` is an audit fact and never
frees a key.

- A row's owner must exist, in the same organization, with the same hostname or app name,
  and every owner must have its row. This is checked by `DEFERRABLE INITIALLY DEFERRED`
  constraint triggers on both sides, so it is validated on the final state at COMMIT and
  the order of inserts inside a transaction does not matter.
- Owner identity, registry identity, release history, app identity and operation intent
  cannot be rewritten; fences and generations only increase; completed deployments cannot
  change status or image; a deleted resource cannot be reactivated; rows cannot be
  deleted, and `BEFORE TRUNCATE` statement guards cover every table above.
- A release is accepted only for a soft-deleted deployment or a withdrawn alias.
- `deployment.app_name` keeps the `lp-[a-z0-9]{10}` namespace; hostnames are
  lowercase DNS names (`<= 253` characters, labels `<= 63`); image tags are unique.
- The validator functions are ordinary `plpgsql` with a fixed `search_path`. They are
  **not** `SECURITY DEFINER`: with no legacy tables there is nothing the application role
  cannot read, so there is no privilege to elevate.

**Residual (stated, not hidden):** these guards are owned by the schema owner, who is also
the application's role today. They defend against bugs and mistaken SQL, not against the
application's own database role, which can still `ALTER` or `DISABLE TRIGGER`. Splitting
owner and application roles is a deployment decision and belongs to the production Compose
plan, where it is also tested through backup and restore (`pg_dump --no-owner
--no-privileges` drops ownership and grants).

## Restore and the recovery gate

A restored database may disagree with the router and Dokku, so model mutations stay off until
the operator reconciles them. Restore writes an owner-only, durable marker
before copying data and sets the restored database gate to `blocked`. Fresh
initialization sets `instance_state.deployment_recovery` to `ready`.

- **Importer crash guard (user decision, 2026-11-20).** The admin's session advisory lock
  cannot survive its death while a separate `pg_restore` continues. Before spawning it,
  persist/fsync `maintenance/deployment-import-in-progress` with an operation identity,
  database identity and importer application name. Clear only after observing child exit
  and import-backend disconnect. A crash or unproven exit keeps the record and refuses
  new restores and recovery-clear, including on an empty database; no schema rollback
  may race that importer. `recovery-ack-import --i-have-stopped-the-importer` requires
  explicit operator confirmation that the exact importer/wrappers and database backend
  have exited, adds a database-backend refusal check, durably audits outside the dump,
  then removes/fsyncs the record. This acknowledgement never clears model recovery.
  The runbook requires both host-process and backend checks; an absent backend alone
  cannot prove a wrapper will not connect later.
- **Scope.** The gate covers **model mutations only**: apps, deployments, aliases, promotions,
  deletions, artifact collection and the worker. Sign-in, sessions, organizations, projects,
  members and API-key administration stay available, or a restored controller could not be used.
- **Checks.** An initialized database must have a ready gate row to accept model mutations. An unreadable marker
  directory or database fails closed. The marker lives in the data directory the artifacts
  already require every process to share (one `LAUNCHPAD_DATA_DIR` volume); a missing mount is a
  startup error, never permission to assume readiness.
- **Clearing.** `launchpad-admin recovery-clear` sets `ready` under the recovery locks, then
  removes the marker and fsyncs the directory (a crash in between stays blocked). **Empty model
  tables prove nothing about remote state**: after an older dump is restored over an installation
  that already used the model, the tables are empty while the router and Dokku still hold the old
  routes and apps. The rule therefore has two parts, and the outcome is unambiguous:
    - **Writer-seen record.** **Before its first model mutation or remote side effect**, the
      first model writer creates and fsyncs the durable file
      `<data dir>/maintenance/model-writer-seen` and its directory, outside the dump, so a
      restore cannot erase it. If that step fails the writer fails closed and performs no
      mutation, so a crash can never leave state behind without the record. P2b has no writer,
      so on a P2b installation the file never exists.
    - **P2b rule (superseded in P3a).** `recovery-clear` **succeeded** only if every model table is empty **and** the
      writer-seen file does not exist; it **refuses** in every other case, including an empty
      database after any writer has run. Rolling back to a P2b binary after P3 has written is not
      supported, and this record is what makes the P2b command refuse if someone does.
    - **Interim rule (implemented in P3a, before any writer exists).** Reconciliation itself is P5, so P3 cannot depend on it. P3a replaces the P2b rule with an **interim fail-closed
      rule** that does **not** consult `model-writer-seen` or the model tables: the file lives on
      the data volume, so a replaced volume restored from an older dump loses it, and empty
      tables cannot be told from a never-used installation. `recovery-clear` therefore **always**
      refuses unless the operator passes the explicit attestation
      `--i-have-reconciled-router-and-dokku`, recorded in an audit event (attestation only, no
      secrets or names). Tests assert the P2b rule is gone, that the command refuses without the flag on a
      database with rows, on an empty one, and with the file absent. This follows the restore
      command's confirmation flags and is weaker than verification, so it is **interim**.
    - **What the attestation covers (the manual procedure until P5).** The flag attests that the
      operator did all of the following, in this order, because nothing verifies it yet:
        1. Closed ingress and stopped every pre-restore writer (controller, worker, admin jobs),
           **and waited for every Dokku operation those writers had already dispatched (build, load,
           destroy) to settle.** Stopping a worker does not stop a dispatched operation, and rotating
           router credentials does not fence Dokku, so a pending destroy could otherwise finish after
           reconciliation and leave the restored database pointing at a missing app.
        2. **Rotated the router epoch and control credentials offline**, so a delayed request from
           a pre-restore writer is rejected. Without this, a higher-generation delayed write is
           accepted by the router (`packages/alias-router/src/store.ts:352-353`) and the restored
           database never records it. This is the fence required by `deployment-modes.md`.
        3. Reconciled the router and Dokku against the restored database (P3: deployments and
           Dokku apps; P4: aliases, with `recovery-raise-counters`).
        4. Only then ran `recovery-clear`.
           The unfenced window exists only if step 2 is skipped, and the consequence is a route change
           the database cannot see. **P5 removes the reliance on memory**: when the restore begins it
           records the router's current epoch ID (not a secret) in the recovery marker, and
           `recovery-clear` verifies the router's epoch now differs from it. The anchor is the
           moment the restore started, **not** the backup manifest: a router that rotated after the
           backup but before the restore would otherwise look like a rotation made during recovery.
           P5 keeps the Dokku settling condition (below): its verified reconciliation runs only after
           the settling rule is met, and the operator procedure still requires it, because nothing
           can prove from the restored database that no dispatched Dokku operation is still running.
    - **Settling rule (what "settled" means).** The set of dispatched operations **cannot come from
      the restored database**: it is exactly the post-backup state the restore lost. So the
      procedure does not try to enumerate it from there.
        1. **Time bound.** Every worker call to Dokku or Docker is bounded by a lease-derived
           deadline, and the worker's documented stop grace is 25 minutes (`docker stop --time 1500`,
           `stop_grace_period: 25m`; a load can take about 24). After the last writer has stopped,
           wait at least that long. Past it, every dispatched call has either finished or hit its
           deadline.
        2. **Host check.** On the Dokku host, confirm that nothing started by the worker's SSH key is
           still running: no `docker build`, `docker load` or `dokku apps:destroy` process for the
           worker's user (for example `pgrep -u <dokku user> -af 'docker|dokku'`).
        3. **Known set (before the restore).** Keep the pre-restore database, which still holds the
           operation rows. List every deployment or deletion operation with a pending step or an
           unexpired lease at stop time, and after steps 1 and 2 read each target app with the
           allowlisted exact-name Dokku read (`apps:exists`). A target whose state disagrees with that
           row is a reconciliation input, never silently ignored.
           The settling wait of a rule-1 duration is all that P5 can automate (it has no host access);
           P5's reconciliation report includes the step-3 list, and steps 2 and 3 stay in the runbook.
    - **Counter repair (P4, built).** `recovery-clear` reads the router through its authenticated
      control endpoint (every page checked for instance and epoch) while the maintenance lock
      excludes model writers. It refuses while any alias `reserved_generation` is below the router's
      generation for its hostname, while the router serves a route (non-null target) for a hostname
      Launchpad has no alias for (a withdrawn route is reported but does not block), when the router
      cannot be read, and when the database holds aliases but no router is configured.
      `recovery-raise-counters` raises counters with `GREATEST` under the alias row lock while the gate
      is set, never lowers one (the database also refuses it), leaves `committed_generation` alone
      and audits the count. The attestation is still required.
    - **Epoch anchor (P5a, built).** The recovery marker is version 2: it records the router's active
      epoch (or none, with the reason) when the restore begins. `recovery-clear` refuses while the router is
      still on it, and needs the audited `--router-epoch-unrecorded` when none was recorded. A rerun after an
      interrupted restore keeps the first anchor and start time; a marker that is damaged or of an unknown
      version reads as having no anchor.
    - **Verified recovery (P5).** Clear holds the exclusive maintenance lock while it compares the
      restored model, reservation integrity, Dokku app/domain inventory, archives, and the
      applicable router and served identities. It compares committed routes and required
      tombstones even for aliases with unfinished operations. Exact acceptance is limited to
      the external findings listed in the [restore runbook](../restore.md); missing evidence and
      router/identity registry conflicts cannot be accepted. Clear waits for the 25-minute stop
      grace and requires the narrow Dokku-host confirmation, not the interim attestation.
      Explicit republish writes and verifies the restored target above both generation fences
      before it commits the repair and settles any superseded chain. It leaves an already
      matching chain alone. A damaged timestamp requires another restore; it cannot waive the wait.

## Verification

Run `omni -i run test:deployment-schema -p @launchpad-kit/controller` with disposable PostgreSQL.
