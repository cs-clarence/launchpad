# Package boundaries and patterns

For contributors deciding where controller code belongs. Keep this index and
its example paths current whenever a boundary or pattern changes.

## Established patterns

| Concern              | Pattern and example                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI and HTTP hosting  | One TanStack Start React app, built for Bun through Nitro: `apps/controller/vite.config.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| API transport        | Elysia 2 RC's fetch handler is mounted in `apps/controller/src/routes/api.$.ts`. It owns no listener.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Services             | Framework-free functions in `packages/services/src`: the role matrix (`authorization.ts`, the only source of organization authorization), organizations, members, projects and API keys (`api-keys.ts`). Caller-facing functions take the caller (`Principal`) and organization; non-members get not-found. Handlers and server functions delegate to them. Do not import Elysia, React, or Start here. Aliases and promotion: `aliases.ts` (create/read), `promotions.ts` (bind/withdraw intent, idempotency, corrective operations), `promotion-claims.ts` (fenced dispatch and finalization), `app-shutdown.ts` (the resumable withdraw-then-delete barrier), and `pins.ts` (`isDeploymentPinned`, the one pin definition deletion and release share); all follow the app, alias, deployment, operation lock order.     |
| SQL and migrations   | Kysely on Bun's native SQL client (`BunSqlDialect`), one instance shared with Better Auth, explicitly constructed in `packages/database/src/index.ts`; forward-only migrations in `packages/database/src/migrations`, run only by the explicit admin command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Organization API     | `apps/controller/src/server/api.ts` maps `ServiceError` codes to statuses (`respond`), and database problems to stable 503s through `database-problem.ts` (never the error text; `classifyDatabaseError` in `packages/database/src/errors.ts` decides from real Bun SQL error shapes). Better Auth's `/api/auth/organization/*` is blocked there; organization changes only go through our services. Pages read via `src/server/data.ts` server functions.                                                                                                                                                                                                                                                                                                                                                                 |
| API reference        | `@elysia/openapi` mounted last in `apps/controller/src/server/api.ts`; operations are described in `src/server/openapi.ts` from the zod schemas in `packages/services/src/contracts.ts`. Scalar's bundle is published from our own origin by `vite.config.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Authentication       | Better Auth is built by `createAuth` in `packages/auth/src/create-auth.ts` from validated configuration; the Elysia adapter mounts it at `/api/auth` and guards cookie mutations by origin in `apps/controller/src/server/api.ts`. Start pages read the session through `apps/controller/src/server/session.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Health and readiness | One shared, single-flight database check, `apps/controller/src/server/schema-gate.ts` (pure, fake-clock tested), behind every request, `/api/ready` and the dashboard; `admission.ts` keeps `/api/health` liveness. Settings parse in `packages/services/src/controller-config.ts` and are validated at startup in `startup-settings.ts`. The dashboard maps problems with `withDatabaseProblems` (`database-problem.ts`) and `src/lib/problem.ts`; a server function error crosses as a fixed code in its message.                                                                                                                                                                                                                                                                                                        |
| Tasks                | Omni runs everything: presets in `omni/presets`, repository-wide tasks and `check:deps` in `tooling/`. Project dependencies are declared in both `package.json` and `project.omni.yaml`; cache keys name every input. See `docs/tooling.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Email                | `Mailer` in `packages/auth/src/mailer.ts` (nodemailer; plain SMTP only to loopback). Invitations live in `packages/services/src/invitations.ts`; tests use the in-process `@launchpad-kit/auth/testing` fake SMTP server.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Contracts and SDK    | `packages/contracts` holds the API's roles, key scopes, input and response schemas (zod only, browser-safe); services and the OpenAPI document import them. `packages/sdk` is the bearer-key HTTP client built on them. `packages/client-core` adds profiles and the credential file for the CLI and MCP, and `session.json` (`session-store.ts`) for the CLI's kept sessions only. The SDK's `createSessionClient` (`session.ts`) is the cookie transport behind `launchpad api --session`; both clients share `transport.ts`.                                                                                                                                                                                                                                                                                            |
| Worker               | `apps/worker`: idle with deployments off; otherwise `deployment-worker.ts` claims through `packages/services/src/deployment-claims.ts`, and `deployment-runner.ts` dispatches fenced steps through `ports.ts`. `deletion-runner.ts` runs manual deletion with `packages/services/src/deployment-deletion.ts`; `packages/services/src/deployment-reconcile.ts` and the admin `deployment-reconcile` command settle held work. `apps/worker/src/heartbeat.ts` is a separate loop that beats into `worker_heartbeat` (`packages/services/src/heartbeat.ts`) under a stable worker name (`worker-id.ts`); the controller derives `ok`/`stale`/`stopped` in `packages/services/src/status.ts`, never the worker. There is no rollback or automatic expiry. Opt-in live tests: `omni -i run test:live -p @launchpad-kit/worker`. |
| Uploads              | `packages/services/src/archive.ts` and `artifacts.ts` validate and store archives for `POST /api/v1/organizations/{orgId}/projects/{projectId}/artifacts` (`app:deploy`). The upload service records each upload project in `artifact_project`. `apps/controller/src/server/body-framing.ts` applies one framing rule to the API and to `/_serverFn/**` (Nitro middleware in `vite.config.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Dokku                | `packages/dokku`: typed, allowlisted operations over ssh with a pinned host key (`client.ts`), validators (`validate.ts`), trust checks (`trust.ts`) and the transport (`transport.ts`). No generic command runner; five error kinds, of which `uncertain` must be reconciled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| UI styling           | Skeleton 5 and Tailwind 4 imports in `apps/controller/src/styles.css`; semantic HTML and body scrolling in `src/routes/__root.tsx` and `index.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| CLI                  | `apps/cli/src/program.ts`: login, logout, whoami, profile, org and projects commands over `@launchpad-kit/client-core`, behind an `Io` interface so tests need no terminal or network; entry in `src/index.ts`. The key is never an argument. `--session` access (`session-flow.ts`, `session-commands.ts`) is decided in `docs/decisions/cli-session-login.md`. It consumes the controller, never Dokku.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Releases             | One shared version for everything that ships: `cog.toml`'s `core` group, synchronized by `tooling/versions.ts` from the bump hook and checked by `check:versions`. `tooling/release-dry-run.ts` rehearses a release and publishes nothing. Rules and checklist: `docs/releasing.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Alias router core    | `packages/alias-router` (private, Bun-only, unwired): durable SQLite routing authority with commit-time epoch/credential checks, bigint-string generations and one hostname registry. Plan: `docs/plans/production-alias-router.md`; evidence: `docs/plans/routing-experiment-evidence.md`. R2a adds listener-free control/data handlers and settings in `src/host/`; the app that binds ports, owns the process lock and runs the operator commands is `apps/router` (R2b). Its managed `rotate` loads only `@launchpad-kit/database/deployment-lock` (the shared recovery advisory lock, a CONNECT-level catalog check); `serve` never loads the database. Controller admin uses the client-only `@launchpad-kit/alias-router/control-client`.                                                                           |
| Testing              | Unit tests need no infrastructure and call `api.fetch(Request)`. Integration tests (`*.spec.ts` in `__tests__`) use a disposable PostgreSQL via `@launchpad-kit/database/testing`; `apps/controller/src/__tests__/hop.spec.ts` drives the built server over HTTP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

The local stdio MCP adapter lives in `apps/mcp/src/server.ts`. It uses only
client-core and the SDK, never controller services or the CLI executable. Per-call
`working_dir` and `launchpad.json` context resolution lives in
`packages/client-core/src/workspace.ts`; it never changes cwd or saved selections.
The CLI's app/alias commands live in `apps/cli/src/app-commands.ts`. The CLI can
pack an explicitly selected static output directory with `packages/client-core/src/pack.ts`;
MCP deploys by artifact ID and never packs local files. Both use
`packages/client-core/src/app-client.ts` to resolve the SDK and organization. MCP checks
the app's actual project against the startup allowlist before a mutation. MCP output is bounded and uses
the same `safeOutput` redaction/control stripping as the CLI (client-core).

The dashboard app panel (`apps/controller/src/components/deployment-apps.tsx`) uses
same-origin HTTP. `packages/services/src/reconciliation-requests.ts` records audit-only
handoffs from recent admin/owner sessions, separate from the operator commands that
verify external evidence and settle held operations.

Operator status is `getStatus` in `packages/services/src/status.ts` behind session-only
`GET /api/v1/status` (database readiness and stored artifacts only).

Operator-only drift collection lives in `apps/controller/src/admin/drift.ts`.
`packages/services/src/drift/read-database.ts` takes bounded, repeatable-read,
read-only snapshots; the existing pure comparer stays in `drift/compare.ts`.
The advisory admin adapter reads external sources between snapshots and drops unstable
findings. `deployment-recovery.ts` instead verifies under the exclusive maintenance
lock, with acceptance policy in `recovery-evidence.ts`; `recovery-republish.ts`
repairs a single exact route and records its verified operation. See [operator usage](../drift.md).

Production Compose configuration: `docker-compose.yaml` (project `launchpad-production`;
one allowlisted `environment` per service, YAML anchors for the settings the controller and worker
must share, secrets as `${VAR:?}`, admin in a profile) with `docker-compose.env.example`;
its shape is asserted by `tooling/compose-production.ts` (`check:compose`, and a unit
spec in `test`). Run once on disposable infrastructure, never as production; see [production Compose](../production-compose.md).
Native router-control TLS is configured in `packages/alias-router/src/host/config.ts`
and bound by `apps/router/src/serve.ts`. Only control clients receive
`LAUNCHPAD_ALIAS_CONTROL_CA_FILE` (worker and admin); their trust is scoped per
request in `packages/alias-router/src/control-client.ts`, never set globally.
The router health client also verifies its control certificate. Compose server
certificate/key mounts belong only to the router. The aliases-on Compose
rehearsal passed on disposable infrastructure; its isolation preflight lives in
`tooling/experiments/compose/`.

The local development seed is `tooling/local-seed.ts` (`omni -i run local:seed`): pure argument,
address and idempotency functions, an HTTP bootstrap over an injected `fetch` and an injected command
runner, so `tooling/local-seed.spec.ts` needs no server or database. It stores the key through
`login` in `@launchpad-kit/client-core`. The guide is `docs/local-quickstart.md`, guarded by
`tooling/local-quickstart.spec.ts`.

The local deployment tool is `tooling/local-deploy.ts` (`omni -i run local:deploy`): pure planning
functions (names, ports, env, inventory validation) and `up`, `status` and `down` over injected seams
(command runner, file system, `fetch`, clock, port probe), so its specs run against the in-memory
`tooling/local-deploy-fake.ts` and never start Docker. It reuses the seed through its Compose mode
(`AdminMode`, stdin password) and imports nothing from the experiments. The guide is
`docs/local-deploy.md`, guarded by `tooling/local-deploy-docs.spec.ts` with helpers in
`tooling/docs-check.ts`.

Scripts and apps that take arguments parse them with commander (`apps/cli`, the controller's `admin`,
`apps/mcp`, `apps/router` and the tooling scripts through `tooling/cli.ts`); tooling uses the root
`devDependencies`, and every other manifest that imports commander declares it itself
(`tooling/declared-deps.spec.ts`). `bundle-migrations.mjs` and the container-copied experiment drivers are the exceptions.

Opt-in disposable rehearsals live under `tooling/experiments/`: `routing/` (the router
experiment and its production-router rehearsal) and `acceptance/` (the full-stack P7 rehearsal:
`run.ts` creates and cleans up resources, `world.ts` is the HTTP/SQL/docker access layer,
`scenarios.ts` is the worked example, `proxy.ts` and `rules.ts` the control-plane fault proxy).
They are never imported by packages or apps, never in CI, and record every resource before
creating it. The separately opted-in public ingress smoke uses `acceptance/ingress.ts`
for an in-process loopback listener, closed in `finally`.
The opt-in restore mode uses `acceptance/restore.ts` for fixture admin commands,
managed router rotation and the real recovery wait; assertions and evidence stay
in `scenarios.ts`.

The health endpoint reports static metadata, not PostgreSQL/Dokku readiness.
Key administration is a dedicated organization-page component in
`apps/controller/src/components/api-keys.tsx`. It imports only browser-safe
contracts, issues through the cookie-authenticated HTTP API, and keeps reveals
out of loader data. `src/lib/api-keys.ts` distinguishes issued/rejected/uncertain
outcomes; never use the generic loader-invalidating mutation path for a reveal.
The operator command and its backup/restore helpers are
`apps/controller/src/admin/{main,backup,restore}.ts`; the built database drill lives in
`apps/controller/src/admin/__tests__/`; Operator procedures are
[install](../install.md), [upgrade](../upgrade.md), [backup](../backup.md),
[restore](../restore.md), [private routing](../access.md), and
[onboarding](../onboarding.md).

The v1 baseline and deployment schema tests exercise permanent identities and immutable
constraints on disposable PostgreSQL. The recovery gate is
`packages/services/src/deployment-recovery.ts`: shared/exclusive advisory locks,
fsynced external marker/writer record, verified evidence and an audited host check.
Only model mutations use that gate; organization/auth/key administration stays available.

Operator login, organizations, members and projects exist, but
the controller is not yet hardened or packaged for exposure to the internet (see the production
plan in `docs/plans/production-compose-follow-up.md`): do not publicly expose it as a management system.

## Approved direction, not yet implemented

The controller will use PostgreSQL for metadata and SSH for privileged Dokku
operations. Application services should depend on narrow repository/adapter
interfaces rather than HTTP framework objects. Implement those interfaces when
the first real feature needs them, not as speculative generic abstractions.

Release machinery (the rest of milestone 6), quotas set per organization (limits exist but are instance-wide), runtime logs and custom domains are
not built; see `docs/plans/application.md`.

## References

- [Elysia / TanStack Start integration](https://elysiajs.com/integrations/tanstack-start)
- [TanStack Start Bun hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting#bun)
- [Kysely introduction](https://www.kysely.dev/docs/intro)
- [Skeleton React layouts](https://www.skeleton.dev/docs/react/guides/layouts)
- [Skeleton React installation](https://www.skeleton.dev/docs/react/get-started/installation/vite-react)
