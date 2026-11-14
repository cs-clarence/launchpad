# Launchpad implementation plan

Status: draft for approval; planning only. For implementers and reviewers. Keep
progress and decisions current; do not interpret proposed packages/endpoints as
implemented. Design and boundaries are in [application design](../design/application.md).

## Assessment

- **Kind:** new application built on an existing bootstrap, delivered as a large,
  staged project rather than one implementation change.
- **Risk:** High. Authentication, cross-organization access, public API/package
  contracts, persistent schema, privileged Docker/SSH execution, concurrency and
  deletion all apply.
- **Extent:** controller/UI, services/auth/database/Dokku, worker, SDK, CLI, MCP,
  artifacts, orchestration, tests, docs and release tooling.
- **Unknowns:** Elysia RC + Better Auth + Start runtime behavior; auth schema/
  Kysely compatibility; PostgreSQL queue transaction/lease behavior; worker/
  Dokku networking and ambiguous SSH completion; registry scope ownership.
- **Reversibility:** planning is additive and reversible. Feature migrations and
  remote operations need tested rollback/containment; deleting previews is not
  intrinsically reversible.
- **Collaboration/time:** first resolve contracts and run risk spikes with one
  owner; then bounded milestones. Estimate after the spikes, not a promised
  calendar duration. No agents launched for this plan.
- **Chosen next step:** review the remaining design, then authorize only
  milestone 0. Do not begin application implementation from this draft.
- **Reassessment triggers:** hostile tenants/builds, multi-host orchestration,
  public signup, OAuth-provider expansion, hosted MCP, automatic Git-provider PR
  builds, or a different deployment engine.

## Observed baseline and explicit choices

Observed: one Start controller with Elysia mounted at `/api`, three in-memory
tests, framework-free metadata service, empty Kysely database type, Dokku
connection types only, CLI help/version, controller image recipe, Bun/Omni,
pinned swe projections, and Pureform-derived generator/Cocogitto config.
There are no real auth, organization, upload, deployment, worker or MCP features.
The current image recipe was not container-built or runtime-tested.

The user selected organization support from v1, static-first deployments, and
permission to save these planning documents. Existing Dokku local state is to
be preserved. No migration, startup, publishing, commit, push or namespace
registration is included in this planning request.

## Finish line and worked example

An instance operator provisions the installation and organizations Acme and
Beta. An authorized Acme deployer creates a project and a scoped API key, then:

```sh
launchpad deploy ./dist --project website --name review --spa --ttl 24h
```

The upload yields a durable deployment ID immediately. Its events survive a
client disconnect; a worker builds from the fixed static template, deploys to
the recorded Dokku app and returns a working flat-subdomain HTTPS URL when
ingress is configured. Acme's dashboard shows the same result. Local MCP can
perform the same operation from an explicitly allowed root using the same
client core and permissions.

Required complexities and failure cases:

1. A Beta session/key guessing Acme's IDs cannot list, download, stream logs,
   deploy, or delete Acme resources. Test every resource family and auth route.
2. An interrupted upload never becomes runnable. A traversal/symlink/bomb archive
   is rejected and cannot write outside temporary artifact storage.
3. A repeated idempotent request creates one deployment; changed payload under
   the same key conflicts.
4. Restart the worker during deployment. Reconcile uncertain Dokku outcome
   without concurrent mutations or duplicate destructive actions.
5. Failed replacement keeps the previous working preview. A TTL extension
   racing expiry does not delete the extended preview.
6. Deleting a preview does not touch a manual Dokku app, another organization's
   resources, or backend volumes/databases.
7. Revoking a key or membership prevents new work and handles queued work by the
   documented revocation policy. Credentials never appear in events.
8. Packed npm CLI/MCP/SDK work outside the workspace; controller/worker images
   start from a documented clean install after authorized migration/setup.
9. Backup/restore recovers metadata, artifacts, auth state and engine linkage;
   a database-only restore is not claimed to restore Docker runtime state.

Turn this example into integration/e2e fixtures over the milestones.

## Decisions required before implementation

1. **Architecture approval:** one UI/API controller, separate privileged worker,
   shared CLI/MCP client core; trusted workloads despite organization boundaries.
2. **Enrollment/recovery — accepted:** configurable offline provisioning and
   SMTP-backed verified invitations/recovery, with offline/operator-only defaults.
   Email-dependent flows require SMTP; public signup is separately controlled
   and disabled by default. Mode changes preserve identities and sessions;
   password resets explicitly revoke affected sessions. See the
   [decision record](../decisions/configurable-identity-provisioning.md).

The user owns these choices. Namespace, license, runtime support and final
quotas/visibility policies are release gates, not blockers to the compatibility
spike. Queue library selection is a spike outcome, not left to an implementation
agent to guess mid-feature.

## Milestones

Each milestone should be split into small vertical PR-sized changes before
execution; auth/schema/contracts and their callers stay together where needed.

### 0. Prove the integration and privilege boundaries

**Depends on:** architecture approval above; enrollment policy is accepted.

- Pin Better Auth/plugin versions and prove session cookies through Start →
  Elysia RC → auth with PostgreSQL. Include org-owned key verification without
  session impersonation, a denied cross-org operation, and body/stream handling.
- Generate and inspect plugin schemas, validating Kysely compatibility and
  explicit migration ordering on a disposable PostgreSQL instance.
- Evaluate a maintained PostgreSQL queue against atomic enqueue, worker death,
  scheduling and Bun compatibility. Record the selected queue and lease/
  reconciliation approach before building dependent features.
- Prove controller-container → worker/Dokku network layout with pinned SSH host
  keys and a static image stream on a disposable app, not the preserved demo.
- Inspect controller/worker image build/runtime behavior and bounded progress
  through the intended ingress.

**Verify:** disposable integration tests plus read-through of trust boundaries.
Test wrong host keys and missing credentials fail closed. Label spikes as
throwaway until accepted. No production data used.

**Undo:** remove disposable resources and test credentials only. No changes to
existing app data. Stop if the RC/library assumptions fail; do not silently
switch frameworks or weaken authentication.

### 1. An operator can establish an authenticated organization

**Depends on:** milestone 0, approved enrollment policy.

- Reviewed migrations, explicit migration command and first-operator setup.
- Local email/password login/logout, session renewal/revocation and chosen
  recovery policy, protected Start pages and Elysia endpoints.
- Org creation/enrollment, membership roles and organization selector.
- One useful protected feature: create/list an org-owned project from UI/API.
- Membership/role/action matrix and cross-org repository constraints.

**Verify:** clean install/migration, concurrent first-setup attempts, login abuse
limits, session/CSRF/sibling-preview-origin checks, cross-org project tests and
accessible UI error/empty/loading states. Obtain independent security review.
Exercise both provisioning modes: no SMTP, valid SMTP, unavailable SMTP,
disabled email-dependent endpoints, operator recovery, email recovery and
mode switching without account/membership/session loss. Verify explicit reset
revocation and no false email verification or public recovery bypass.

**Undo:** stop management access, restore pre-migration backup if required; prefer
forward-compatible migrations over destructive downs. Never remove users'
existing Dokku workloads as an auth rollback.

### 2. A scoped automation client can access its organization

**Depends on:** milestone 1.

- User/org-owned API-key issuance, one-time reveal, expiry/revocation, action and
  project restrictions, audit events and no privilege escalation.
- Versioned API contracts and browser-safe HTTP SDK.
- Shared local profiles/credential handling and CLI secure key login,
  `whoami`, organization selection and project listing with JSON output.
- Browser/device login is optional after the key path works; settle session vs
  OAuth token semantics explicitly if included.

**Verify:** removed memberships, revoked/expired keys, read-only writes denied,
org key isolation, keys unable to mint elevated keys, credential redaction,
SDK error compatibility and clean credential-store behavior.

**Undo:** revoke the new keys, disable affected automation endpoints; retain
browser access and audit history. Credential-format changes need migration or
clear re-login, never silent credential loss.

### 3. One static artifact reaches a working preview

**Depends on:** milestones 0–2.

- Streaming bounded archive upload from CLI/dashboard, manifest/digest validation,
  org-scoped artifact storage, quotas and interrupted-upload cleanup.
- Explicit preview creation, generated app/hostname mapping and idempotent
  deployment submission committed with its durable job.
- Worker uses fixed Nginx templates, optional SPA fallback and unique image tags.
  Stream images through the narrow Dokku SSH adapter and verify proxy readiness.
- Status and persisted progress visible in CLI/dashboard; finite timeouts and
  failure records. Start with polling; add SSE only with reconnection tests.

**Verify:** static fixture and SPA route success, non-SPA real 404, malicious/
oversized archives rejected, organization isolation on artifacts/logs, retry/
idempotency cases, resource limits and replacement failure preserving uptime.
Run live engine tests only against explicitly disposable apps.

**Undo:** disable new deployment submission and drain/stop workers safely. Revert
the affected preview using its retained prior image/artifact. Only delete
resources created and recorded by these test/deploy operations.

### 4. Local MCP provides the same safe deployment workflow

**Depends on:** milestone 3 and stable client-core operations.

- Stdio MCP executable and shared client-core calls, no CLI subprocess wrapping.
- Explicit controller/org profiles and allowed roots; read-only tools by default.
- Opt-in deploy/delete tools with explicit mutation authorization, bounded
  structured output, schema validation and stderr-only diagnostics.
- CLI and MCP share packaging, safe errors, auth and idempotency behavior.

**Verify:** a real MCP client can list, deploy the fixture and track completion.
Test symlink/root escape, disallowed filesystem reads, missing/insufficient
scopes, malicious logs and output size/protocol correctness. Tool annotations
alone must not authorize anything.

**Undo:** disable mutating MCP tools or revoke their key. Controller behavior and
CLI remain usable. The MCP package has no host-level management credentials.

### 5. Previews expire and recover predictably

**Depends on:** milestone 3; can follow milestone 4 or be scheduled before it.

- TTL selection/extension, durable scheduled expiry, manual deletion and
  ownership-safe artifact/image cleanup.
- Worker restart reconciliation, per-app serialization, retry budgets,
  cancellation semantics and visible operator attention for ambiguous outcomes.
- Runtime logs, durable audit events, dependency readiness, worker heartbeat and
  storage/retention/backlog indicators.

**Verify:** concurrent deploy/delete/extend cases, expiry after downtime,
orphan/foreign-app safety, stale workers, SSH timeout-after-success and
database unavailability. Explicitly demonstrate no global Docker prune and
no volume/database deletion.

**Undo:** pause scheduling/cleanup, preserve artifacts and jobs for reconciliation.
Deletion cannot be magically rolled back: use retained artifacts/backups and
document which metadata/URLs can be restored.

### 6. A clean user can install, back up and upgrade v1

**Depends on:** milestones 1–5, namespace/license decisions.

- Explicit Compose services/profiles for controller, worker, PostgreSQL and
  Dokku. Document socket privilege and container/host path mapping. Preserve
  current repo-local state; migrate only with explicit backup/approval.
- Finish actual controller/worker image recipes, secret mounts, dependency
  readiness and migration/setup steps. No implicit public admin exposure.
- Compile/package npm CLI/MCP/SDK with proper JS/declarations, dependency ranges,
  export maps, executable entry points and package allowlists.
- Implement/test Cocogitto version and lockfile synchronization; define release
  groups and API compatibility before enabling release workflows.
- Publish only through an explicit subsequent release authorization. Use
  least-privilege CI identity, package-content checks and image provenance.
- Docs for local/private management, Cloudflare/Tailscale preview routing,
  onboarding, API keys, MCP roots/permissions, restore and upgrade.

**Verify:** clean-machine install from packed tarballs and image artifacts,
supported Node/Bun platforms, npm execution without workspace dependencies,
non-root container behavior, no secrets in tarballs/layers, upgrade from the
previous test version and a full backup/restore drill.

**Undo:** stop rollout, pin previous compatible image/client versions and restore
tested backups where schema changes require it. npm releases are effectively
immutable: deprecate/fix forward instead of assuming unpublish is possible.

### 7. Later capabilities, separately approved

- Trusted prebuilt backend images, environment secrets and explicit persistence
  lifecycle; preview deletion never implicitly destroys a datastore.
- Git/provider integration and PR previews with separate build credential and
  hostile-code threat assessment.
- Multi-host workers, stronger workload isolation, remote MCP/OAuth ecosystem,
  custom domains, organization/team refinements and registry integrations.

These are a roadmap, not v1 acceptance requirements or authorization to build
speculatively. Reassess each before implementation.

## Verification and collaboration policy

Keep existing checks: build, type checks, lint, formatting and unit tests.
Add PostgreSQL/auth integration tests before deployment work, then explicitly
opted-in Dokku/container/e2e suites and CLI/MCP package-consumer tests. Never
claim in-memory tests prove live SSH, migration or image compatibility.

An independent reviewer must inspect high-risk auth/tenant/migration and
privileged worker changes. Do not start parallel implementation until contracts
are agreed. If delegation is later approved, isolate client/MCP, UI and worker
slices with exact inputs/outputs and checks; one integrator runs broad checks
and verifies the worked example after combining them.

Scope each milestone's normal checks to its actual changes; run the full suite
at integrated release milestones. Record skipped checks and remaining risks.

## Readiness gate and current status

- [x] Repository and existing boundaries inspected.
- [x] Better Auth password/org/key/PostgreSQL/Elysia docs checked.
- [x] User selected organizations, static-first scope and saved draft documents.
- [x] Architecture alternatives, data/API/trust boundaries, client/MCP sharing,
      milestones, failure cases, verification and undo documented.
- [x] Namespace public-profile checks recorded without claiming ownership.
- [x] User approved configurable offline/SMTP enrollment and recovery, with
      offline defaults and independently disabled public signup.
- [ ] User approves the remaining architecture.
- [ ] Milestone 0 is separately authorized; spikes and independent review complete.
- [ ] Product license and authenticated registry ownership verified before release.

No feature code or runtime was changed for this plan. The design is ready for
review, not approval to implement the whole roadmap. After review, preserve
accepted decisions in `docs/decisions/` and start only the approved first slice.
