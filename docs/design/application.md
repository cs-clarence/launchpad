# Launchpad application design

Status: proposed, awaiting design approval. This is a target architecture, not a
description of implemented behavior. For contributors planning the application;
keep it aligned with the implementation plan and record accepted costly
decisions separately before building on them.

## Purpose and agreed scope

Launchpad turns a prebuilt web directory into a remotely accessible preview,
with one authenticated control plane shared by a dashboard, CLI, and local MCP
server. Dokku remains the deployment engine.

The user selected:

- Separate organizations from the first release, not a single-owner-only model.
- Static-directory previews first; backend images and Git builds are later work.
- Bun, PostgreSQL, Kysely, Elysia 2 RC, TanStack Start/React, Skeleton 5, and the
  existing Pureform-derived monorepo/generator.
- Future public npm packages and container images, not publication now.

Assumed for the initial product: one Linux/Docker/Dokku installation, trusted
users and artifacts, private management ingress, and optional public preview
URLs. Organization access control does **not** provide hostile-workload isolation
on a shared Docker host. Public self-service hosting, billing, arbitrary shell
execution, Kubernetes, and remote hosted MCP are out of scope.

## Recommendation: one web application, separated capabilities

Keep dashboard and API in `apps/controller`, on one origin and in one image.
Elysia stays mounted in TanStack Start's API routes. Keep services independent
of both frameworks. A separate worker process/container handles privileged jobs.

```text
Dashboard ────────────────────────┐
                                │
CLI ─┐                          │
     ├─ local client core ─ SDK ─┼─ Controller: Start UI + Elysia HTTP API
MCP ─┘                          │        │
                                │   auth + authorization + services
                                │        │
                                └──── PostgreSQL + artifact storage
                                             │
                                      durable job worker
                                      │              │
                               fixed-template    SSH to Dokku
                               image build           │
                                             preview containers
```

The diagram's lines represent dependency/traffic direction, not direct database
access for CLI/MCP. Only the controller and worker access server-side state.

Alternatives considered:

- **Separate API and dashboard deployments:** cleaner independent rollout, but
  introduces cookie/CORS/CSRF configuration, two images and version coordination.
  No demonstrated need yet. Preserve an API module boundary so extraction later
  does not rewrite services.
- **Everything inside the HTTP process:** fewer processes but ties request
  availability to builds, long jobs and privileged credentials. Reject for
  deployment execution.
- **Local clients directly invoking Dokku/services:** skips centralized auth,
  auditing and job ownership. Reject. Share the client workflow layer instead.

One web deployment does not mean one container for the entire platform:
PostgreSQL, worker, Dokku and app containers remain separate.

## Package and runtime boundaries

| Location                 | Responsibility                                                | Distribution                           |
| ------------------------ | ------------------------------------------------------------- | -------------------------------------- |
| `apps/controller`        | Start pages, Elysia routes, composition, session UI           | Bun container                          |
| `apps/worker`            | Durable job execution, builds, expiry and reconciliation      | Bun container                          |
| `apps/cli`               | Human/CI command adapter and output                           | npm executable                         |
| `apps/mcp`               | Local stdio MCP tool adapter                                  | npm executable; optional image         |
| `packages/services`      | Authorized application use cases and policy                   | Private workspace                      |
| `packages/auth`          | Better Auth configuration and identity normalization          | Private workspace                      |
| `packages/database`      | Kysely schema types, repositories and migrations              | Private workspace                      |
| `packages/dokku`         | Allowlisted, typed SSH operations and output handling         | Private workspace                      |
| `packages/contracts`     | Versioned DTOs, errors and input schemas                      | Public if required by SDK              |
| `packages/sdk`           | HTTP transport, auth headers, errors and event consumption    | Public npm library                     |
| `packages/client-core`   | Profiles, credentials, artifact packaging and deploy workflow | Shared by CLI/MCP; publish if required |
| existing config packages | TypeScript/build/test configuration                           | Keep private initially                 |

Do not create every package at once; add each with its first tested feature.
Services never receive an Elysia context or call UI code. Infrastructure is
injected through narrow interfaces, introduced when a real use case needs them.
Browser-safe SDK exports must not pull in filesystem or credential-store code.

Develop all packages with Bun. Recommend Node-compatible published CLI/MCP/SDK
builds so npm users need not install Bun; the controller/worker remain Bun-native.
This changes the CLI's current Bun-target build at the distribution milestone,
not as part of this plan.

## Authentication and organization authorization

### Better Auth integration

Use Better Auth's local database-backed email/password login. Organization
membership/enrollment and API keys live in Launchpad services, not Better Auth's
organization or API-key plugins; the milestone 0 plugin spike is historical.
See [organization roles and keys](../decisions/organization-roles-and-operator-access.md).
Username login is optional;
"local" does not require an external identity provider, but does not imply
password-reset/invitation email works without a mail/provisioning policy.

Mount the auth handler under `/api/auth/*`, without double-prefixing `/api`.
Keep product endpoints under `/api/v1/*`. Validate the complete Start → Elysia
RC → Better Auth mount and `Set-Cookie` propagation in the first spike.

PostgreSQL is supported by Better Auth through Kysely. Its docs show a `pg.Pool`,
a dialect, or a configured Kysely instance. Pin compatible versions and verify
schema generation before choosing the shared connection/pool lifecycle.

Keep auth-generated tables owned by auth migrations and application tables by
application migrations; use one reviewed, ordered migration execution process.
Never run uncontrolled schema changes on every HTTP process startup.

### Identity and permissions

Normalize credentials into an internal principal:

```text
principal = { actorType, actorId, organizationId, scopes, credentialId? }
```

- Browser: server-validated Better Auth session plus current organization
  membership. A browser's active organization is a convenience, not authorization.
- API key (milestone 2): org-owned credential bound to its creator's original
  membership. Effective permissions are the intersection of the granted scopes
  and the creator's current role, plus optional project restrictions. Removing
  and re-adding the creator never revives the key. Keys do not inherit an instance
  operator role and are not browser sessions. Separate user-key and independent
  service-account credential types are not implemented.
- No missing-credential fallback, even over localhost.

Proposed organization roles: owner, admin, deployer, viewer. Instance operator is
a separate installation role controlling hosts and enrollment, not an automatic
cross-organization browsing role. Define and test the action matrix before
exposing membership APIs.

Milestone 2 scopes use the service actions `organization:read`, `member:read`,
`project:read`, `project:create` and `project:delete` (reserved until its endpoint
exists). Later preview/log actions will extend that list. Membership/key administration requires
dedicated elevated permissions and browser-session reauthentication as needed.
Keys cannot mint more powerful keys or bypass project restrictions.

Do not enable API-key session impersonation. Better Auth explicitly warns about
that option; verify the key once per request and carry its actual principal.
Enforce resource authorization inside services so workers or future transports
cannot silently bypass it. Workers execute persisted authorized intentions and
recheck applicable revocation/membership policy before starting queued work.

Keys are shown once, stored as SHA-256 hashes by Launchpad services, individually
revocable and expiring. Keep key values, cookies and passwords out of logs and
job payloads. Test every enabled auth/plugin route, not just product endpoints,
for scope escalation or unintended account creation.

Both email and operator password recovery revoke the user's API keys. Operator
recovery performs its password change, credential revocation and audit in one
transaction. Better Auth's email hook runs after its password transaction; it
revokes credentials before auditing so audit failure does not restore keys.
Hook failure is reported, but may require operator recovery because the password
change and token consumption may already have committed.

### Enrollment and interactive CLI login

Propose invite-only/operator-controlled enrollment, not unrestricted public
signup. First operator creation must be an explicit local setup command with
transactional first-run protection, not "first public visitor becomes admin."
No built-in/default password.

Accepted: support both offline operator provisioning and SMTP-backed flows,
configurable per installation. See the
[identity provisioning decision](../decisions/configurable-identity-provisioning.md).

- Default to operator-provisioned accounts and disabled email.
- Configure enrollment independently: operator-only or invitation-based.
- Configure email independently: disabled or SMTP. Email-dependent invitations,
  verification and recovery require working SMTP; never bypass verification
  because mail is unavailable.
- Keep authenticated local operator recovery available in both modes. Email
  self-service recovery is an additional capability when SMTP is enabled.
- Public signup stays disabled by default and is a separate policy, not an
  automatic consequence of enabling SMTP.
- Offline organization membership is explicitly granted by an authorized
  operator; it is not evidence of email ownership. Do not silently mark arbitrary
  email/password identities verified.
- Switching modes preserves accounts, memberships and sessions. An operator
  password reset explicitly revokes the affected user's sessions and records an
  audit event; it must not expose a password-reset bypass over the public API.

First CLI/MCP auth can use an explicitly created scoped API key, entered through
stdin/secure prompt or environment, not a command-line argument. Browser-based
CLI login is a later convenience within v1 if the integration spike succeeds:
Better Auth's device flow has distinct first-party session and OAuth access-token
paths. Pick deliberately; do not call a returned session token a scoped API key.
If implementing OAuth device authorization, verify audience, issuer, expiry,
consent, client registration, refresh-token storage and scope enforcement.
Keep it out of the initial critical path.

### Browser and preview trust boundary

Use host-only secure HTTP-only cookies, restrictive SameSite settings, trusted
origins and CSRF protections. Never set an auth cookie for the entire preview
parent domain. Sibling preview subdomains are same-site, so SameSite alone is
not sufficient: validate mutation origins and test sibling-origin attacks.
Prefer a separate registrable management domain where practical.

Reserve management hostnames and never allow preview users to claim them.
Forward hostnames correctly through ingress. Preview authentication and
controller authentication are different: the Dokku `http-auth` plugin protects
app traffic, not the Launchpad dashboard. Public previews are explicit; private
management access does not make previews private automatically.

## Data and API design

Reuse Better Auth's organization/membership/invitation/key tables rather than
inventing a parallel identity model. Application-owned entities:

- Project: organization, name, policy/default TTL and timestamps.
- Preview: project/org, logical slug, generated Dokku app identifier, hostname,
  desired state, active deployment, expiry and deletion state.
- Deployment: preview/org, immutable artifact/image identity, actor, request
  idempotency key, job reference, status/timestamps and safe failure details.
- Artifact: organization, content digest, byte count, manifest and storage
  location; deduplicate within an org, not by a cross-org existence oracle.
- Job/event: operation, org/resource, attempt/lease, phase, outcome, ordered
  progress sequence and retention.
- Audit event: actor/key, organization, operation, target, result and request ID.

All tenant-owned rows and repository calls require organization context.
Use constraints/composite references to prevent cross-org links, unique
org/project slugs, UTC timestamps, and opaque IDs. UI display names must never
become SSH arguments. Derive globally unique flat hostnames from a slug plus
opaque ID, e.g. `demo-a1b2c3.example.com`, avoiding deeper wildcard TLS needs.

Initial product API outline, subject to contract review:

```text
GET    /api/v1/me
GET    /api/v1/organizations/:orgId/projects
POST   /api/v1/organizations/:orgId/projects
POST   /api/v1/organizations/:orgId/artifacts
POST   /api/v1/organizations/:orgId/projects/:projectId/previews
GET    /api/v1/organizations/:orgId/previews/:previewId
POST   /api/v1/organizations/:orgId/previews/:previewId/deployments
GET    /api/v1/organizations/:orgId/deployments/:deploymentId
GET    /api/v1/organizations/:orgId/deployments/:deploymentId/events
GET    /api/v1/organizations/:orgId/previews/:previewId/logs
DELETE /api/v1/organizations/:orgId/previews/:previewId
```

Creation/deployment/deletion enqueue operations and return job/deployment IDs,
not synchronous long-running HTTP responses. Mutations use idempotency keys
bound to principal, org, endpoint and payload hash; reusing a key with a different
payload is a conflict. State changes and job insertion commit together.

Return stable machine error codes, safe messages and request IDs. Use cursor
pagination for lists and bounded logs. Start with polling and add reconnectable
SSE progress if the ingress spike confirms it; resumable event sequences remain
persisted. Do not leak credentials through event URLs or expose raw SSH errors.

## Static deployment path

1. CLI/MCP packages an explicitly allowed directory, or dashboard accepts a
   supported archive/directory upload. For v1, a bounded archive upload is the
   simplest browser baseline; folder-picker support is additive.
2. Authenticate and authorize before receiving large bodies. Stream to bounded
   temporary storage; enforce upload/uncompressed byte, entry count, path depth,
   quota and timeout limits.
3. Validate every entry: reject path traversal, absolute/drive paths, symlinks,
   hardlinks, devices and duplicate/conflicting paths. Exclude secrets such as
   `.env*`, `.git` and private keys by policy. Require `index.html` for the first
   static-site release; no user Dockerfile/build command is executed.
4. Atomically finalize an org-owned content-addressed artifact. Interrupted
   uploads stay temporary and expire; never enqueue partial uploads.
5. A transaction records the deployment and durable job. The worker packages
   the artifact using Launchpad's fixed, versioned Nginx template. SPA fallback
   is explicit, not default for every site.
6. Build a uniquely tagged image from that fixed template in the worker's
   configured Docker engine, then stream it with SSH `git:load-image` to Dokku.
   Registry access is unnecessary for this static workflow.
7. Deploy under the recorded generated Dokku app name. Wait for engine checks,
   then probe through the proxy using the correct Host header. Treat public
   ingress validation as a separate signal from local readiness.
8. Mark the deployment active only after verified success. Failed replacement
   deployments must not delete a working preview; retain prior image/artifact
   references for diagnosis and an explicit redeploy.

The worker gets the privileged builder Docker access and pinned Dokku SSH
credentials; the HTTP controller gets neither. Docker socket access still means
host-level privilege, even in another container. Only fixed-template static
builds and trusted workloads are supported. Host keys must be provisioned and
verified, never silently accepted or disabled.

The SSH adapter has a fixed operation vocabulary, strict argument validation,
timeouts, cancellation and bounded output. No arbitrary shell/API/CLI passthrough.
Store instance-level host connection metadata, but keep raw private keys in
read-only runtime secret mounts, not tenant rows or images.

## Jobs, concurrency and reconciliation

Use PostgreSQL-backed jobs rather than adding Redis. Select a maintained
PostgreSQL queue if the first spike confirms transactional insertion, leases,
scheduling and Bun support; otherwise review the explicit queue design before
implementation. Do not pretend an in-process promise is durable.

Begin with one worker and conservative global build concurrency. Serialize work
per preview, with durable operation identity and lease ownership. The external
Dokku side effect is not transactionally atomic with PostgreSQL: do not promise
exactly-once execution.

Proposed phases: queued → preparing → building → deploying → verifying →
succeeded/failed. Cancellation is requested separately; it is not complete until
the worker confirms work has stopped. An uncertain SSH completion becomes a
reconciliation-needed condition, not permission to blindly redeploy.

Use bounded retries for transient failures only. After process death, reconcile
recorded app/image/deployment identity with Dokku before retrying. Do not let an
expired lease and stale worker concurrently mutate the same app. Block uncertain
per-app operations until resolved.

## CLI and local MCP share a client core

Proposed CLI:

```sh
launchpad login --controller https://control.example.com
launchpad org use acme
launchpad deploy ./dist --project website --name demo --spa --ttl 24h
launchpad previews list
launchpad deployments logs <deployment-id>
launchpad previews delete <preview-id>
launchpad mcp --root /absolute/path/to/allowed/projects
```

`login` initially accepts a securely entered API key; browser/device login must
not be implied before implemented. CLI flags resolve explicit controller and
organization profiles; non-interactive mode produces stable JSON/exit codes.

Local stdio MCP tools call the same client-core operations as the CLI, without
spawning the CLI or importing privileged controller services. Tools include
listing projects/previews, deploying a directory, reading status/logs, and
requesting preview deletion. Responses are structured and bounded.

MCP server startup is not permission to deploy arbitrary local files:

- Deployment requires startup-configured include and exclude glob lists; exclude
  always wins. Resolve patterns against each call's `working_dir` (or its startup
  default), canonicalize paths, keep the source within that directory, and reject
  symlinks. Filesystem roots are not mandatory. This is the user-approved replacement
  for the original allowed-roots proposal; see the
  [milestone 4 plan](../plans/milestone-4-local-mcp.md).
  A client-selected directory plus broad patterns can publish matching private files
  anywhere the process can read. The operator accepts that authority when enabling
  deployment; patterns are not a directory authorization boundary. Use narrow
  patterns and an OS sandbox or a restricted OS account when directory isolation is
  required. Do not expose arbitrary shell execution or file-content read tools.
- Use the same packaging/secret exclusions as the CLI, plus server validation.
- Default MCP keys to read-only; enable deployment/deletion deliberately.
- Require explicit mutation authorization/confirmation policy; tool annotations
  are hints, not an enforcement mechanism. Deletion uses stable resource IDs.
- Keep tokens and file contents out of tool descriptions/errors. Treat logs and
  deployed content as untrusted data, not tool instructions.
- Use stderr for diagnostics and stdout only for MCP protocol messages.

Share secure credential/profile handling between CLI and MCP. Prefer an OS
credential store; a portable file fallback must be explicit with restrictive
permissions. Do not bake profile secrets into an MCP container or example config.

## Lifecycle, storage and operations

TTL, extensions, manual deletion and scheduled expiry use the same authorized
service/job path. Recheck expiry and desired state before destructive steps.
An extension races safely with expiry; a deleted preview cannot be revived by an
older queued deployment. Stop/deploy/delete operations have explicit ordering.

Only delete Dokku apps recorded as Launchpad-owned. Existing/manual Dokku apps
are never auto-imported or swept. Database/volume deletion is outside the static
preview cleanup path. Garbage-collect only unreferenced Launchpad artifacts and
images after retention; never run a global Docker prune.

Store metadata in PostgreSQL and static artifacts in a configured local volume
first. Image/container storage remains Docker-managed. Back up PostgreSQL,
artifacts, Dokku state and runtime secret recovery separately; describe restore
order and test a full restore. Do not back up only the repo and call it complete.

Provide liveness, dependency readiness, job backlog/age and worker heartbeat,
structured request/job logs and audit events. Bound log/artifact retention;
avoid a full monitoring stack until measurements justify it.

## Distribution and naming

Product name remains Launchpad; publishing namespaces need not equal the
internal `@launchpad/*` workspace scope.

Recommended candidate: **launchpadops**.

```text
npm:        @launchpadops/cli, @launchpadops/mcp, @launchpadops/sdk
optional:   @launchpadops/contracts, @launchpadops/client-core
Docker Hub: launchpadops/controller, launchpadops/worker
optional:   launchpadops/dokku, launchpadops/mcp
fallback:   ghcr.io/cs-clarence/launchpad-controller
```

Availability observations from public read-only checks, 2026-11-14:

- Unscoped npm `launchpad` exists and belongs to another project.
- `launchpadops`, `launchpadkit`, and `launchpadhq` returned HTTP 404 from Docker
  Hub's public user and organization lookups.
- npm organization pages returned HTTP 403 for all three candidates.
- No scope/org was registered. Empty listings/404s do not prove a namespace can
  be registered, is unreserved, or is controlled by this project.

The user must confirm/register the selected namespaces through authenticated
registry flows before release. Do not rename workspace packages or claim
availability based on these checks. GitHub ownership does not confer npm or
Docker Hub ownership. Confirm project license before any package publication;
the copied generator's MIT notice is not a whole-project licensing decision.

Public npm packages need compiled JS/declarations and explicit export/file
lists, not the scaffold's TypeScript source exports or `workspace:` references.
Test tarballs in a clean consumer outside the monorepo. CLI/MCP must run without
server dependencies, PostgreSQL, SSH keys or Docker installed.

Ship pinned version/SHA image tags and multi-architecture images only for
verified targets. Publish with least-privilege/trusted CI credentials,
provenance/SBOMs where supported, and package-content/secret checks.
Cocogitto already registers release groups but has no version/lockfile
synchronization helper; implement and test that before release automation.
No automatic pushes or releases are authorized by this design.

## Remaining decisions and references

Before feature implementation: approve the deployment/trust topology. Configurable
offline/SMTP provisioning is accepted as described above. The first compatibility
spike resolves Elysia RC/auth mounts and the PostgreSQL queue choice.

Before release: confirm namespace ownership, license, supported client/runtime
matrix, default quotas/TTL/retention, preview public/private defaults and operator
backup/recovery policy. Suggested starting policy is explicit public preview
opt-in and configurable finite TTLs; no values are hardcoded by this plan.

Primary references checked:

- [Better Auth introduction](https://better-auth.com/docs/introduction)
- [Local email/password](https://better-auth.com/docs/authentication/email-password)
- [Organization plugin](https://better-auth.com/docs/plugins/organization)
- [API keys](https://better-auth.com/docs/plugins/api-key)
- [API-key session/organization caveats](https://better-auth.com/docs/plugins/api-key/advanced)
- [PostgreSQL and Kysely](https://better-auth.com/docs/adapters/postgresql)
- [Elysia integration](https://better-auth.com/docs/integrations/elysia)
- [Device authorization token distinctions](https://better-auth.com/docs/plugins/device-authorization)
- [Implementation sequence](../plans/application.md)
