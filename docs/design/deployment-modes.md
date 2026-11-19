# Immutable deployments and promotion

Status: **revised proposal** (2026-11-19). The user selected immutable
deployments and promotion instead of separate persistent/preview app paths.
On the user's “Go ahead” following the readiness review, the document now fixes
the contracts needed for an initial routing experiment. The full feature is
**not ready to implement** until that experiment passes and its evidence is reviewed.
This replaces the earlier proposal for `app.mode = preview | persistent`.
Aliases are first-class and many per app. Custom domains, domain verification,
DNS-provider integration and certificate automation are future work, not this slice.

## Goal and assessment

Build and deploy an artifact once, give that deployment its own stable URL, then
promote it to production by changing routing—not rebuilding or overwriting an app.
Production and preview are exposure/promotion states of the same deployment,
not two build pipelines.

- **Kind/risk:** Large, High: schema, routing, authorization, worker leases,
  deletion, dashboard and all clients change.
- **Scope:** static sites only. No arbitrary Dockerfiles, dynamic runtimes,
  databases, autoscaling or multiple Docker engines per project.
- **Routing choice:** a dedicated generation-checked alias router, specified in
  `docs/decisions/immutable-deployment-alias-routing.md`. Runtime/implementation
  selection and feasibility are the experiment's output, not already verified.
- **Execution:** settle contracts first; deliver bounded slices with independent
  review of promotion concurrency, remote outcomes and garbage collection.
- **Undo:** before cutover, abandon the candidate; after cutover, promote the
  previous retained deployment. Schema rollback remains matched backup restore,
  not down migrations. Existing previews may be retired rather than converted.
- **Not authorized here:** broad deletion, registry publishing, production startup
  or modification of existing ingress/connectors.

## Resource model

```text
Project
└── App (stable hosted identity, e.g. "website")
    ├── Deployment A → Dokku app A → unique deployment URL
    ├── Deployment B → Dokku app B → unique deployment URL
    ├── Production alias → deployment A or B
    ├── Staging alias → deployment A or B
    └── Other generated aliases → deployment A or B
```

Both A and B use the same upload/build/load/verify pipeline. Each has a fresh
opaque Dokku name. A successful deployment's artifact, SPA setting, image,
Dokku app and unique hostname are immutable.

“Preview” means access through the unique deployment URL, not a different app
type. “Production” is an operator-designated alias, not a deployment enum.
Several aliases may point to one deployment, and each alias may move independently.
An unbound alias reserves its hostname but serves no application content until its
first successful promotion. Withdrawing a route is a tracked operation, not a
database-only delete.
Promoting B does not destroy A or remove B's unique deployment URL.
Preview expiry is a retention policy, not the definition of a deployment type.

Launchpad enforces immutability; an operator with Docker/Dokku access can still
modify resources outside it. Do not describe this as protection against that operator.

## Database proposal

Add new forward-only migrations; never rewrite frozen migrations.

| Table                 | Responsibility                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`                 | Organization/project, live-unique slug and timestamps. No preview/persistent mode or single production hostname.                                                              |
| `deployment`          | App/artifact references, fixed settings, unique Dokku `app_name`, unique deployment hostname, job status, lease/fence, image identity, retention deadline and deletion state. |
| `deployment_event`    | Existing ordered deployment progress/events.                                                                                                                                  |
| `app_alias`           | Stable alias ID, app ID, live-unique per-app slug, generated hostname, committed target deployment ID, routing generation and lifecycle state. Many aliases per app.          |
| `promotion_operation` | Alias ID, desired target, previous target, expected alias generation, status, lease/fence, actor, idempotency key and routing reconciliation details.                         |
| `deletion_operation`  | Guarded deletion of one deployment's resources, rather than a mutable preview target.                                                                                         |

Retain organization-qualified foreign keys. An alias may reference only a
deployment of the **same app and organization**. Only a succeeded, verified,
non-deleting deployment can be promoted. Enforce that eligibility transactionally;
a foreign key alone cannot enforce deployment status.

Do not enforce one alias per app or derive a stored hostname from current settings
on each read. Hostnames must be globally unique across deployment routes and alias
routes, not merely unique within each table. Use a shared hostname reservation
mechanism. Alias removal retains its reservation until remote withdrawal is
confirmed, including when removal is uncertain.

Hostname allocation/admission is separate from binding an alias to a deployment.
Initially allocation only accepts generated labels under the configured app domain;
clients cannot submit arbitrary hostnames or bypass the management-domain boundary.
A future externally provisioned custom hostname can reuse the alias binding,
promotion and retention contracts after its admission/ownership policy is designed.
This does not add a custom-domain endpoint, ACME client or DNS provider now.

Keep hostname and Dokku-name uniqueness even for retired records. A fresh
deployment never adopts a previous deployment's remote app.

The current one-unfinished-deployment-per-preview rule becomes per-app
serialization initially. Distinct remote apps make parallel builds possible, but
parallel release jobs are not needed for the first version.

### Concrete schema constraints

- `app`: UUID primary key; unique `(organization_id, id)`;
  organization-qualified project FK; live-unique `(project_id, slug)`.
- `deployment`: unique `(organization_id, app_id, id)`; FK
  `(organization_id, app_id)` to `app`; organization-qualified artifact FK.
  Replace the old unfinished-per-preview index with an unfinished-per-app index
  on `app_id` for `queued`, `preparing`, `building`, `deploying`, `verifying`,
  `reconciliation-needed`.
- `app_alias`: unique `(organization_id, app_id, id)` and live-unique
  `(app_id, slug)` where state is not `withdrawn`; nullable `target_deployment_id`; composite target FK
  `(organization_id, app_id, target_deployment_id)` to `deployment`.
  Eligibility is checked in the transaction, not inferred from that nullable FK.
- `hostname_reservation`: canonical lowercase `hostname` primary key,
  `owner_kind` (`deployment`, `alias` or `legacy_preview`), UUID `owner_id`, organization ID,
  `created_at`, nullable `released_at`, unique `(owner_kind, owner_id)`.
  Insert it in the same transaction as its owning resource, with a database
  `DEFERRABLE INITIALLY DEFERRED` constraint trigger verifying the polymorphic
  owner and reciprocal hostname reference at transaction commit. No other table
  may allocate a hostname outside this registry.
  `released_at` is an audit fact, **not** permission to reuse the hostname.
  Seed every legacy hostname before admitting new allocations. Preserve registry
  tombstones on organization/app deletion: no cascading delete from the organization;
  retired owner identities remain in minimal history so reciprocal references hold.
- `promotion_operation`: alias/app/organization-qualified FK; action `bind` or
  `withdraw`; previous and desired target FKs qualified to the same app; desired
  target required only for `bind`. Store `generation`, UUID operation ID, status,
  `attempt`, `lease_owner`, `lease_expires_at`, progress, errors and timestamps.
  Include nullable `supersedes_operation_id` and `superseded_by_operation_id`,
  constrained to operations of the same alias. Unique `(alias_id, generation)`;
  the unfinished-per-alias index covers only unfinished operations with
  `superseded_by_operation_id is null`.
  Alias DELETE is a `withdraw` operation with the same fences and history.

Store `preview_expires_at` (required) and `last_unpinned_at` (nullable) on
`deployment`; pins prevent destruction, not the recording of its preview deadline.

An unbound alias begins at generation 0. Use a PostgreSQL bigint, expose decimal
strings in HTTP/router contracts, and never pass it through JavaScript numbers.
`reserved_generation` advances on accepted intent; `committed_generation` and
`target_deployment_id` advance only after the router outcome is verified.
Generation gaps are allowed; numbers are never reused, even for failed requests.

### Alias and operation state machines

| Alias state            | Meaning and permitted next states                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `unbound`              | Hostname reserved, fixed 404; may enter `binding` or `withdrawing`.                                                           |
| `bound`                | Committed route exists; may enter `binding` to repoint or `withdrawing`.                                                      |
| `binding`              | One bind intent pending; success → `bound`; proven-no-change failure → prior stable state; uncertainty → `binding-uncertain`. |
| `binding-uncertain`    | Both candidate targets pinned; reconciliation only, to `bound` or the prior stable state after observed/fenced correction.    |
| `withdrawing`          | Target pinned until fixed-404 tombstone is verified; success → `withdrawn`; uncertainty → `withdrawal-uncertain`.             |
| `withdrawal-uncertain` | Reconciliation only; keep all possible targets pinned.                                                                        |
| `withdrawn`            | Tombstone and reservation retained; terminal. A new alias gets a new ID and hostname.                                         |

Operation statuses: `queued → applying → verifying → succeeded`. `failed` means
it is proven no delayed mutation can still alter the route; any ambiguous outcome
is `reconciliation-needed`, which blocks ordinary new operations for that alias. A later
worker may reclaim `queued` work, but a lease expiry after dispatch is uncertain,
not proof of a safe retry. Reconciliation can resume verification or create a
corrective operation: under the normal locks, allocate a higher
`reserved_generation`, mark the old operation superseded, and insert the
linked corrective operation in the same transaction. Only that new operation is
eligible for dispatch; never reuse an old generation for different contents.
Every possible target from the full superseded-operation chain stays pinned until
the corrective barrier is verified. Then finalize the old rows as `superseded`
with their observed outcome and release only pins no longer referenced.
If correction is itself uncertain, the full chain remains pinned.
The router must reject stale generations independently of DB leases.

Claim/reclaim increments `attempt`; every operation write requires matching
operation ID, attempt and a live lease. Use existing bounded deadlines, with a
five-minute routing lease and command/probe timeouts strictly inside it. Persist
dispatch intent before calling the router. Finalization verifies the exact
operation ID, generation, target and deployment identity.

Resource allocation first obtains the organization quota advisory transaction
lock (`apps-quota:<organization-id>`) before counting/reserving quota or creating
an app, deployment or alias. All code paths acquiring it do so before any app lock.
All app mutations then lock in this order: app row, alias rows ordered by UUID,
deployment rows ordered by UUID, then operation rows. This deliberately
serializes pin allocation/release and garbage-collection eligibility per app;
remote I/O happens outside the transaction. Deletion marks a candidate `deleting`
under those locks before remote destruction, so a promotion cannot reserve it
after the check. An app in shutdown rejects new promotions and deployments.

Promotion and deletion lock the same app/deployment records in a defined order.
Creating a promotion reserves the target until the operation is resolved;
deletion must refuse if any committed alias, unfinished promotion or unresolved
routing outcome can still reference that deployment.

## One deployment pipeline

1. Upload an artifact as today.
2. Create a deployment under an app. Assign its opaque remote name and unique URL.
3. Worker builds the fixed template, loads into the new Dokku app and verifies
   the deployment identity through its unique hostname.
4. Success makes it eligible for promotion; failure cleans up only its own
   resources and cannot touch the current production deployment.
5. After success, no in-place rebuild or redeploy to that Dokku app. A retry that
   needs to change a completed deployment creates another deployment ID/app.

Reuse existing artifact checks, bounded Dokku vocabulary, leases and audit
events. Change the current failure rollback path: do not rebuild/reload a previous
release into a mutable target; production remains on its existing deployment.

## Promotion, routing and rollback

The user selects an alias and a succeeded deployment and requests promotion. No artifact
upload, image build or Dokku reload occurs.

1. In a transaction, authorize, check target eligibility and expected alias
   generation for that alias, reserve the target, and create an idempotent promotion operation.
2. A leased routing operation switches the stable hostname to that deployment.
3. Probe the stable hostname for the expected deployment ID.
4. Commit the observed target/generation and mark the promotion succeeded.
   UI/API distinguish the committed target from a pending requested target.
5. Keep the previous deployment for a configurable rollback window.

**Routing is not a database transaction.** A timeout or crash after cutover must
enter `reconciliation-needed`, with old and new targets both protected from
cleanup. Read the observed route/probe state before retrying or committing. Do not
announce the old target as certainly live while remote state is uncertain.

Use a managed alias router/gateway that atomically replaces one hostname's
upstream mapping and routes to a deployment's immutable Dokku hostname. The
disposable spike must prove the correct upstream Host header, TLS/SNI behavior,
visibility and persistence of the mapping, and stale-writer protection. A database
fence does not itself fence a delayed remote route update.

Unbound, withdrawn and unknown hosts get a fixed router 404 with no redirect,
no upstream lookup and no default Dokku content. Never route aliases directly
into Dokku's fallback virtual host. The decision record defines the control-plane
contract, failure behavior and disposable experiment. Direct Dokku domain
attach/detach is rejected for this version; a failed router experiment requires
revisiting the design, not silently substituting that approach.

An operator may put either route behind public HTTPS, a tunnel, Tailscale or
another private gateway. External ingress reaches the alias router for stable
aliases; unique deployment routes reach their corresponding Dokku apps. Management
remains a separately configured origin.

Rollback uses the same promotion operation targeting a retained succeeded
deployment. It is a routing change, not a rebuild. Failure before cutover leaves
production unchanged; uncertain failure after cutover requires reconciliation,
not a blind second cutover.

## Configurable hostname templates

```env
LAUNCHPAD_APPS_DOMAIN=sites.example.net
LAUNCHPAD_DEPLOYMENT_HOSTNAME_TEMPLATE={slug}-{id}-preview
LAUNCHPAD_ALIAS_HOSTNAME_TEMPLATE=view-{slug}-{id}
```

- Deployment template tokens refer to the app slug and deployment's unique ID.
- Alias template tokens refer to the alias slug and alias's stable unique ID.
- Thus each alias keeps the same hostname when its target deployment changes.
- `{slug}-{id}-view` is an alternative alias template. Promoting does not
  rename the unique deployment hostname or turn its `-preview` suffix into `-view`.
- Only `{slug}` and `{id}` are supported, each required exactly once. Generate
  one DNS label, require a random ID, validate DNS syntax and worst-case label/
  hostname lengths, and retry collisions within a bound.
- Resource IDs remain UUIDs. The hostname `{id}` is a distinct 10-character
  lowercase base36 random token (same alphabet/length as current opaque Dokku
  names; current legacy hostnames used only six characters, unlike this proposal).
  Slugs are 1–40 lowercase alphanumeric/hyphen characters, with alphanumeric
  ends. Validate the template with a 40-character slug and 10-character token
  against the 63-character label and 253-character total limits. Retry allocation
  at most five times on a registry collision, then return a conflict; never
  truncate a slug or use a UUID in the hostname token.
- Persist generated hostnames. Template/domain changes apply to new resources
  only; public routes must not silently change on restart or promotion.
- Preserve opaque Dokku names and their allowlist, independent of hostname syntax.
- The app domain must remain on a different registrable domain from management.
  Both preview and production content are untrusted static uploads.
- Public base URLs and internal worker/router probe addresses remain independently
  configurable. DNS, certificates and tunnel provisioning are operator concerns.

### Canonical configuration

| Setting                                                   | Initial value / contract                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LAUNCHPAD_BASE_URL`                                      | Exact operator-configured HTTPS management origin; unchanged.                                                                                                                         |
| `LAUNCHPAD_APPS_DOMAIN`                                   | Required when the new pipeline is enabled; no real domain guessed.                                                                                                                    |
| `LAUNCHPAD_APPS_PROXY_URL`                                | Internal Dokku proxy URL for immutable deployment probes; trusted operator setting.                                                                                                   |
| `LAUNCHPAD_ALIAS_CONTROL_URL`                             | Private authenticated router control endpoint; worker/admin only, never browser input.                                                                                                |
| `LAUNCHPAD_ALIAS_INSTANCE_ID`                             | Stable installation UUID bound to router authorization.                                                                                                                               |
| `LAUNCHPAD_ALIAS_CONTROL_TOKEN_FILE`                      | Required read-only mounted private token file; never log it or accept it in a URL, command argument or public API. Rotate with bounded credential overlap, then revoke the old token. |
| `LAUNCHPAD_ALIAS_ROUTER_EPOCH_FILE`                       | Persisted non-secret epoch UUID; normal restart preserves it. Offline recovery establishes a new epoch and credentials together.                                                      |
| `LAUNCHPAD_ALIAS_PROBE_URL`                               | Internal router data-plane URL; worker sends the alias Host header.                                                                                                                   |
| `LAUNCHPAD_DEPLOYMENT_HOSTNAME_TEMPLATE`                  | `{slug}-{id}-preview`                                                                                                                                                                 |
| `LAUNCHPAD_ALIAS_HOSTNAME_TEMPLATE`                       | `view-{slug}-{id}`                                                                                                                                                                    |
| `LAUNCHPAD_DEFAULT_TTL` / `LAUNCHPAD_MAX_TTL`             | Preview retention defaults remain 7d / 30d.                                                                                                                                           |
| `LAUNCHPAD_ROLLBACK_RETENTION`                            | 7d; positive duration, at most 30d initially.                                                                                                                                         |
| `LAUNCHPAD_MAX_APPS`                                      | 10 per organization.                                                                                                                                                                  |
| `LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP`                       | 20 retained/allocated instances, including failed resources awaiting cleanup.                                                                                                         |
| `LAUNCHPAD_MAX_DEPLOYMENTS`                               | 100 per organization, including allocation reservations.                                                                                                                              |
| `LAUNCHPAD_MAX_ALIASES_PER_APP` / `LAUNCHPAD_MAX_ALIASES` | 10 per app / 100 per organization; withdrawing/uncertain aliases count until terminal.                                                                                                |

This is a coordinated pre-release configuration break: reject old
`LAUNCHPAD_PREVIEW_DOMAIN`, `LAUNCHPAD_PREVIEW_PROXY_URL`,
`LAUNCHPAD_MAX_PREVIEWS` and `LAUNCHPAD_ALLOW_NO_EXPIRY` with an actionable error,
not silent precedence or permission changes. Update examples, Compose tasks and
`docs/tooling.md` in the same implementation slice. The feature remains disabled
until required URLs and router trust are configured. No external service is
started to run configuration/hostname unit tests.
Fail closed when enabled router settings or token/epoch files are absent,
unreadable or invalid. Credential material is never included in diagnostics.

## API proposal

All paths below are relative to `/api/v1/organizations/{orgId}`.

| Method/path                                                         | Purpose                                                                                                                      |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `POST /projects/{projectId}/apps`                                   | Create a stable app identity; body `{ "slug": "website" }`. No deployment mode or implicit alias.                            |
| `GET /apps` / `GET /apps/{appId}`                                   | Apps and alias summaries, including committed targets and pending routing state.                                             |
| `POST /apps/{appId}/aliases`                                        | Create a generated alias from a slug such as `production` or `staging`. It starts unbound; binding is an explicit promotion. |
| `GET /apps/{appId}/aliases` / `GET /apps/{appId}/aliases/{aliasId}` | List/read independent aliases and their routing state.                                                                       |
| `DELETE /apps/{appId}/aliases/{aliasId}`                            | Asynchronously withdraw a route; keep its current target pinned until withdrawal is confirmed.                               |
| `POST /apps/{appId}/deployments`                                    | Deploy once; body `{ "artifactId": "...", "spa": false }`. Returns 202 and job ID.                                           |
| `GET /apps/{appId}/deployments`                                     | All release candidates/history; production status is derived from alias references.                                          |
| `GET /deployments/{deploymentId}` / `/events`                       | Existing job status/events plus unique URL, retention and alias references.                                                  |
| `POST /apps/{appId}/promotions`                                     | Body `{ "aliasId": "...", "deploymentId": "...", "expectedGeneration": "3" }`; returns 202 and promotion operation ID.       |
| `GET /apps/{appId}/promotions`                                      | Promotion and rollback history.                                                                                              |
| `GET /promotions/{operationId}`                                     | Pending/succeeded/failed/reconciliation-needed outcome.                                                                      |
| `POST /deployments/{deploymentId}/extend`                           | Extend retention for an unaliased deployment.                                                                                |
| `DELETE /deployments/{deploymentId}`                                | Guarded async deletion; refuses any protected target.                                                                        |
| `DELETE /apps/{appId}`                                              | Explicit destructive app shutdown; must withdraw and verify all routes before deleting referenced deployments.               |

Rollback is another `POST /apps/{appId}/promotions` selecting the same alias and an older deployment;
do not introduce a separate divergent rollback pipeline.

Promotion requests support idempotency and compare-and-swap alias generation.
The request's `expectedGeneration` is a decimal string, for example `"3"`,
and must match `reserved_generation`, not the last committed generation.
Read responses expose both generations, the committed target and pending intent.
Implementation schemas must not accept a JSON number for a bigint generation.
Stale generations return 409 without routing side effects. Unknown remote
outcomes are exposed, not disguised as success. Promotion reconciliation stays
session-only with authorized admin/owner and recent authentication.

Old `/previews` contracts are intentionally replaced before initial publication,
with all clients and OpenAPI updated together. This is a documented breaking API,
not a hidden compatibility change.

## Retention, authorization and UX

- A configurable preview retention deadline applies to unaliased deployments.
  **Any** alias or unfinished/uncertain route operation pins its possible targets,
  regardless of an earlier preview deadline.
- After demotion retain the old target for at least the rollback window; do not
  immediately expire it because its original preview deadline passed.
- Scheduled collection rechecks all pins under lock before issuing destruction.
  Explicit deletion must use the same guards. App shutdown is an explicit
  authorized exception that first withdraws routes; force flags cannot bypass
  uncertain routing.
- Separate scheduled retention from explicit deletion, so manual deletion can
  execute while automatic expiry is off. Deployments remain off by default.
- Quotas count retained remote deployment instances, not just app identities;
  otherwise immutable releases multiply resources without limit. Refuse new
  allocations at the quota rather than deleting pinned production targets.
- Bound alias counts independently. Removing one alias does not unpin a deployment
  still referenced by another; rollback retention begins only after the relevant
  references and unfinished operations release it.
- Track `last_unpinned_at` when the final alias/operation pin is released; update it
  under the shared lock discipline. Eligibility is only after
  `max(preview_expires_at, last_unpinned_at + LAUNCHPAD_ROLLBACK_RETENTION)`,
  with the second term absent for a never-pinned deployment. Multiple aliases
  do not start separate destructive timers. An explicitly authorized DELETE may
  waive time-based retention, but never bypass reference/uncertainty pins.
- Use explicit new `app:read`, `app:deploy`, `app:promote`, `app:delete` scopes.
  Alias creation and withdrawal also require an explicit `app:alias:manage` scope
  for API keys and corresponding organization permission; deploying alone cannot
  create, repoint or withdraw stable routes.
  Old preview-only keys do not automatically gain promotion permission. Current
  organization roles/project restrictions remain enforced; propose deployer and
  above may promote when their key explicitly allows it. Reconciliation remains
  admin/owner only.
- Dashboard: one app with an alias list and deployment history. Candidate
  releases expose “Open preview” and “Promote to production”; previous retained
  releases expose rollback via promotion. Choose the alias explicitly, with
  `production` as a conventional name rather than a hardcoded routing type.
  Show pending/uncertain route status independently for every alias.
- CLI/SDK/MCP expose deploy and promote separately. Deploying never implicitly
  promotes. MCP promotion is an explicit opt-in mutation with confirmation and
  project restrictions; permission to upload/deploy alone does not enable it.
- Shared artifact retention protects artifacts referenced by retained deployments,
  and image/app cleanup is always by exact recorded ownership.

### Permission matrix and client confirmation

An API key needs both the listed scope and its creator's current organization
role/project access. Sessions need the role, not an API key scope. Instance
operator status never grants organization membership.

| Endpoint/action                                   | Required scope for keys                                | Minimum role |
| ------------------------------------------------- | ------------------------------------------------------ | ------------ |
| Read app/deployment/alias/operation               | `app:read`                                             | viewer       |
| Create app or deploy artifact                     | `app:deploy`                                           | deployer     |
| Extend deployment retention                       | `app:deploy`                                           | deployer     |
| Create/withdraw alias                             | `app:alias:manage`                                     | deployer     |
| Promote or roll back alias                        | `app:promote`                                          | deployer     |
| Delete unpinned deployment                        | `app:delete`                                           | deployer     |
| Shut down app (withdraw all aliases, then delete) | All of `app:delete`, `app:alias:manage`, `app:promote` | admin        |
| Reconcile uncertain routing/deletion              | No keys; session and recent authentication             | admin        |

Migration revokes every API key containing any legacy `preview:*` scope, with
audit counts, and invalidates its sessions only if a separate account-recovery
operation is requested; API-key revocation alone does not imply session revocation.
Unrelated keys remain unchanged. Never map old preview grants to new grants.
Reject old scope values in new issuance and fail closed on legacy stored keys.
Expect existing deployment automation keys to need reissuance: current keys
carrying any preview permission are all revoked, not grandfathered.

MCP exposes promotion only with explicit `--allow-promote`, configured allowed
projects, a key with `app:promote`, and literal `confirm: true` in the request.
Require exact app, alias, deployment IDs and expected generation; reject names
that need ambiguous resolution. Tool output shows old/new target and operation ID.
This follows the current deploy/delete confirmation convention: it is explicit
tool input, **not proof that a human approved the action**. Alias management has
its own `--allow-alias-manage` startup opt-in; deploy permission does not imply
either opt-in.

### Legacy retirement and backup/restore boundary

Live upgrade requires all legacy previews terminally deleted and every legacy
deployment/deletion operation finished, including rollback intent. Keep their
rows/events as read-only `legacy_*` history, outside the new worker/GC selection.
Migration refuses active/held legacy work; it never destroys remote apps or
implicitly marks an unknown remote outcome resolved. Legacy `rollback_*` fields
stay in historical records only; new deployments have no in-place rollback intent.

**New binaries refuse pre-model backups before restoring any files or schema.**
Add the immutable-model migration to the backup compatibility floor. Older dumps
may be opened with the earlier binary in an isolated forensic environment, never
used to restart new workers or automatically recreate retired apps. New-format
backups preserve the legacy history alongside the new tables.
The floor is defined by the backup manifest's `migrations` array containing the
immutable-model migration ID, not by `launchpadVersion` or the backup's date.
Keep `BACKUP_FORMAT = 1`: directory/manifest serialization is unchanged; this
is schema compatibility policy. A new binary may still take a pre-upgrade backup
of an older schema, but must prominently report “restore only with the previous
compatible binary” and list the missing floor migration. Verification can confirm
integrity without implying that the current binary will restore it.

This is an intentional pre-release restore-compatibility break, chosen instead
of allowing a restored old database to reintroduce mutable targets. Record it
in upgrade/restore/release notes. The frozen schema-014 fixture can still prove
old-schema migration and retirement preconditions, but the new round-trip
restore drill must use a post-model backup and additionally assert the old
backup refusal. Do not weaken the floor merely to keep the old test unchanged.

Aliases need separate remote reconciliation after every restore: ingress stays
closed, promotions/deletions off. First fence every pre-restore writer: establish a
new router epoch and rotate control credentials, because a write issued after the
backup may still be delayed and the restored database cannot know it. Then compare
saved intentions with the router's durable state, keeping acknowledged generations
and tombstones and never replaying an older route over a newer one. The restored
`reserved_generation` can be lower than what the router already acknowledged,
because the backup cannot record later writes. Promotions and deletions stay
disabled until each alias's `reserved_generation` is at least the highest
generation the router acknowledged for it, including writes recorded in the router
after the backup. Reconciliation raises it to that value or higher; otherwise each
promotion would reserve a stale number and the router would reject it with a 409. A fresh router
needs an explicit offline bootstrap into a new epoch with old credentials fenced out.
The concrete bootstrap/recovery procedure must pass the routing experiment.

## Delivery and acceptance

1. Establish the routing mechanism with an independently
   reviewed disposable spike. No destructive migration until cutover/reconciliation
   and stale-writer behavior are demonstrated.
2. Inventory and retire exact existing previews through the guarded deletion path.
   Await terminal operations and remote settling, then stop workers. The migration
   refuses active or unfinished legacy previews; do not silently truncate tables.
   Keep retired history as specified above; do not attempt an automatic
   conversion of an active mutable app.
3. Implement schema/types/contracts, immutable worker path, promotion operation,
   retention guards and admin backup/restore checks.
4. Update API/OpenAPI, dashboard, SDK, CLI, MCP, examples and docs together.
5. Verify on disposable infrastructure:
    - A and B have separate Dokku apps/URLs and only one build each.
    - Promoting B changes the production alias without rebuilding either image.
    - Rollback to A is a routing-only change.
    - Failed B never changes A's live production route.
    - Competing promotions, delayed remote updates and crash-after-cutover reconcile
      safely without deleting either possible live target.
    - Preview expiry never deletes aliased/pending targets; demotion gets its
      rollback window, and cleanup respects organization/project ownership.
    - Two aliases can reference one deployment, move independently, and withdrawing
      one cannot delete the target while the other still points to it.
    - Templates can rearrange segments without changing old routes.
    - Auth scope checks, quota boundaries, app shutdown, matched backup/restore
      and all client interfaces behave consistently.
    - Unbound, withdrawn and unknown aliases return fixed 404, never another app.
    - Delayed old-generation mutations cause no router change; restart preserves
      acknowledged routes and tombstones.
    - Two promotions at one expected generation produce one accepted intent and
      one 409; GC racing that reservation cannot destroy the candidate.
    - Retention after the last pin release observes the later deadline; withdrawing
      an alias with an uncertain outcome retains all possible targets.
    - A pre-model backup is rejected before mutation; post-model restore compares
      router epochs/generations and does not replay stale routing.
    - Old preview keys cannot promote/manage aliases; MCP without its promotion
      opt-in/confirmation cannot mutate aliases.

### Implementation slices and gates

| Slice                                                               | Check                                                                                                                                                                        | Undo / stop condition                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Docs, pure template/config functions, read-only legacy inventory | Unit tests; no remote calls or active API/schema changes                                                                                                                     | Remove additive helpers; preserve existing runtime.                                                                                                                                                                                                                                           |
| 1. Disposable alias-router experiment                               | Router-only generation/idempotency, restart/crash, fixed-404, Host/SNI and epoch tests; throwaway driver simulates dispatch/response loss without the new application schema | Exact-name removal of newly created test resources; if an invariant fails, stop. Explicit disposable-infrastructure approval required.                                                                                                                                                        |
| 2. Retirement and coordinated backend/model change                  | Schema upgrade, pre-model backup refusal, worker/auth tests, DB CAS, GC/reservation races, retention and corrective-chain pin tests                                          | Restore the pre-change matched backup with the previous binary into an isolated target. No mixed-version workers. New immutable apps/router state are absent from an old backup: inventory them by exact name and quarantine them from old workers before separately approved orphan cleanup. |
| 3. API/UI/SDK/CLI/MCP integration                                   | New contracts, permission matrix and generated-hostname workflows across all clients                                                                                         | Keep draft/unreleased; do not publish a half-compatible client/server set.                                                                                                                                                                                                                    |
| 4. Combined disposable rehearsal and operator docs                  | Build once, preview, multi-alias promotion/rollback, failures, restore and exact cleanup                                                                                     | Withdraw only test routes; retain uncertain targets until reconciled. Production remains untouched.                                                                                                                                                                                           |

Use the production-preparation draft PR. It may temporarily be marked ready for
CI/CodeRabbit review, then returned to draft once that round is green. Do not
merge until the combined contracts, routing and verification are complete.
No production startup,
publishing or broad cleanup is implied by selecting this design direction.
