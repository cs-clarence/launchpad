# Launchpad application design

Status: approved and largely built (milestones 0 to 5; see `docs/plans/application.md` and
the milestone plans). This is the target architecture: where a later note says a part is
deferred (runtime logs, for one), that wins. For contributors planning the application;
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
exists). P3 adds `app:read`, `app:deploy` and `app:delete`; promotion and alias scopes follow
in P4 (the dashboard key form offers them in P6). Membership/key administration requires
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

### Browser and deployment trust boundary

Keep the management origin on a different registrable domain from deployments.
App ingress and management authentication are separate; see [access](../access.md).

## Deployment model

See [deployment and routing design](deployment-modes.md) for apps, immutable
deployments, aliases, client authorization, and recovery.

## Distribution and naming

Product name remains Launchpad. On 2026-11-19 the user selected
`@launchpad-kit/*` for all workspace packages, including private packages.
Public package names use that same scope. The executables remain `launchpad`,
`launchpad-mcp` and `launchpad-admin`. No registry ownership has been verified
and nothing is published.

The Docker namespace is a separate decision; the existing local image names
are unchanged by the package-scope rename.

Earlier candidate (2026-11-14, historical rather than the selected npm scope):
**launchpadops**.

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
registry flows before release. The workspace rename was explicitly authorized;
these old public checks do not establish availability. GitHub ownership does not confer npm or
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
