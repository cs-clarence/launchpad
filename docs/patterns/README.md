# Package boundaries and patterns

For contributors deciding where controller code belongs. Keep this index and
its example paths current whenever a boundary or pattern changes.

## Established patterns

| Concern             | Pattern and example                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI and HTTP hosting | One TanStack Start React app, built for Bun through Nitro: `apps/controller/vite.config.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| API transport       | Elysia 2 RC's fetch handler is mounted in `apps/controller/src/routes/api.$.ts`. It owns no listener.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Services            | Framework-free functions in `packages/services/src`: the role matrix (`authorization.ts`, the only source of organization authorization), organizations, members, projects and API keys (`api-keys.ts`). Every function takes the caller (`Principal`) and organization; non-members get not-found. Handlers and server functions delegate to them. Do not import Elysia, React, or Start here.                                                                                                                                             |
| SQL and migrations  | Kysely on Bun's native SQL client (`BunSqlDialect`), one instance shared with Better Auth, explicitly constructed in `packages/database/src/index.ts`; forward-only migrations in `packages/database/src/migrations`, run only by the explicit admin command.                                                                                                                                                                                                                                                                               |
| Organization API    | `apps/controller/src/server/api.ts` maps `ServiceError` codes to statuses (`respond`). Better Auth's `/api/auth/organization/*` is blocked there; organization changes only go through our services. Pages read via `src/server/data.ts` server functions.                                                                                                                                                                                                                                                                                  |
| API reference       | `@elysia/openapi` mounted last in `apps/controller/src/server/api.ts`; operations are described in `src/server/openapi.ts` from the zod schemas in `packages/services/src/contracts.ts`. Scalar's bundle is published from our own origin by `vite.config.ts`.                                                                                                                                                                                                                                                                              |
| Authentication      | Better Auth is built by `createAuth` in `packages/auth/src/create-auth.ts` from validated configuration; the Elysia adapter mounts it at `/api/auth` and guards cookie mutations by origin in `apps/controller/src/server/api.ts`. Start pages read the session through `apps/controller/src/server/session.ts`.                                                                                                                                                                                                                            |
| Tasks               | Omni runs everything: presets in `omni/presets`, repository-wide tasks and `check:deps` in `tooling/`. Project dependencies are declared in both `package.json` and `project.omni.yaml`; cache keys name every input. See `docs/tooling.md`.                                                                                                                                                                                                                                                                                                |
| Email               | `Mailer` in `packages/auth/src/mailer.ts` (nodemailer; plain SMTP only to loopback). Invitations live in `packages/services/src/invitations.ts`; tests use the in-process `@launchpad-kit/auth/testing` fake SMTP server.                                                                                                                                                                                                                                                                                                                   |
| Contracts and SDK   | `packages/contracts` holds the API's roles, key scopes, input and response schemas (zod only, browser-safe); services and the OpenAPI document import them. `packages/sdk` is the bearer-key HTTP client built on them. `packages/client-core` adds profiles and the credential file for the CLI and MCP.                                                                                                                                                                                                                                   |
| Worker              | `apps/worker`: idle with deployments off; otherwise `deployment-worker.ts` claims through `packages/services/src/deployment-claims.ts`, and `deployment-runner.ts` dispatches fenced steps through `ports.ts`. `deletion-runner.ts` runs manual deletion with `packages/services/src/deployment-deletion.ts`; `packages/services/src/deployment-reconcile.ts` and the admin `deployment-reconcile` command settle held work. There is no rollback or automatic expiry. Opt-in live tests: `omni -i run test:live -p @launchpad-kit/worker`. |
| Uploads             | `packages/services/src/archive.ts` and `artifacts.ts` validate and store archives for `POST /api/v1/organizations/{orgId}/projects/{projectId}/artifacts` (`app:deploy`). The upload service records each upload project in `artifact_project`. `apps/controller/src/server/body-framing.ts` applies one framing rule to the API and to `/_serverFn/**` (Nitro middleware in `vite.config.ts`).                                                                                                                                             |
| Dokku               | `packages/dokku`: typed, allowlisted operations over ssh with a pinned host key (`client.ts`), validators (`validate.ts`), trust checks (`trust.ts`) and the transport (`transport.ts`). No generic command runner; five error kinds, of which `uncertain` must be reconciled.                                                                                                                                                                                                                                                              |
| UI styling          | Skeleton 5 and Tailwind 4 imports in `apps/controller/src/styles.css`; semantic HTML and body scrolling in `src/routes/__root.tsx` and `index.tsx`.                                                                                                                                                                                                                                                                                                                                                                                         |
| CLI                 | `apps/cli/src/program.ts`: login, logout, whoami, profile, org and projects commands over `@launchpad-kit/client-core`, behind an `Io` interface so tests need no terminal or network; entry in `src/index.ts`. The key is never an argument. It consumes the controller, never Dokku.                                                                                                                                                                                                                                                      |
| Releases            | One shared version for everything that ships: `cog.toml`'s `core` group, synchronized by `tooling/versions.ts` from the bump hook and checked by `check:versions`. `tooling/release-dry-run.ts` rehearses a release and publishes nothing. Rules and checklist: `docs/releasing.md`.                                                                                                                                                                                                                                                        |
| Alias router core   | `packages/alias-router` (private, Bun-only, unwired): durable SQLite routing authority with commit-time epoch/credential checks, bigint-string generations and one hostname registry. Plan: `docs/plans/production-alias-router.md`; evidence: `docs/plans/routing-experiment-evidence.md`. R2a adds listener-free control/data handlers and settings in `src/host/`; the app that binds ports, owns the process lock and runs the operator commands is `apps/router` (R2b).                                                                |
| Testing             | Unit tests need no infrastructure and call `api.fetch(Request)`. Integration tests (`*.spec.ts` in `__tests__`) use a disposable PostgreSQL via `@launchpad-kit/database/testing`; `apps/controller/src/__tests__/hop.spec.ts` drives the built server over HTTP.                                                                                                                                                                                                                                                                           |

The local stdio MCP adapter lives in `apps/mcp/src/server.ts`. It uses only
client-core and the SDK, never controller services or the CLI executable. Per-call
`working_dir` and `launchpad.json` context resolution lives in
`packages/client-core/src/workspace.ts`; it never changes cwd or saved selections.
File selection (operator
include/exclude globs, exclude wins) lives in `packages/client-core/src/pack.ts`, kept for the app deploy command. MCP output is bounded and uses
the same `safeOutput` redaction/control stripping as the CLI (client-core).

Operator status is `getStatus` in `packages/services/src/status.ts` behind session-only
`GET /api/v1/status` (database readiness and stored artifacts only).

The health endpoint reports static metadata, not PostgreSQL/Dokku readiness.
Key administration is a dedicated organization-page component in
`apps/controller/src/components/api-keys.tsx`. It imports only browser-safe
contracts, issues through the cookie-authenticated HTTP API, and keeps reveals
out of loader data. `src/lib/api-keys.ts` distinguishes issued/rejected/uncertain
outcomes; never use the generic loader-invalidating mutation path for a reveal.
The operator command and its backup/restore helpers are
`apps/controller/src/admin/{main,backup,restore}.ts`; the frozen earlier-schema
fixture and built-artifact upgrade drill live in
`apps/controller/src/admin/__tests__/`; Operator procedures are
[install](../install.md), [upgrade](../upgrade.md), [backup](../backup.md),
[restore](../restore.md), [private routing](../access.md), and
[onboarding](../onboarding.md).

The model SQL has moved
to the real migration `packages/database/src/migrations/20261119_018_deployment_model.ts`;
`deployment-model.spec.ts` and `deployment-cutover.spec.ts` exercise it using
`test:deployment-schema` on disposable PostgreSQL. P1 fixtures, old-process tests
and inventory are removed. `Database` describes the new physical tables;
artifact collection pins `deployment`, and `check-restore` reports
immutable deployment identities. The recovery gate is
`packages/services/src/deployment-recovery.ts`: shared/exclusive advisory locks,
fsynced external marker/writer record and the audited attestation `recovery-clear` requires.
Only model mutations use that gate; organization/auth/key administration stays available.

Operator login, organizations, members and projects exist, but
the controller is not yet hardened or packaged for exposure to the internet (see the production
plan in `docs/plans/production-compose-follow-up.md` and the follow-ups in
`docs/plans/milestone-5-lifecycle.md`): do not publicly expose it as a management system.

## Approved direction, not yet implemented

The controller will use PostgreSQL for metadata and SSH for privileged Dokku
operations. Application services should depend on narrow repository/adapter
interfaces rather than HTTP framework objects. Implement those interfaces when
the first real feature needs them, not as speculative generic abstractions.

Release machinery (the rest of milestone 6), quotas set per organization (limits exist but are instance-wide), runtime logs and custom domains are
not built; see `docs/plans/application.md` and the follow-ups in
`docs/plans/milestone-5-lifecycle.md`.

## References

- [Elysia / TanStack Start integration](https://elysiajs.com/integrations/tanstack-start)
- [TanStack Start Bun hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting#bun)
- [Kysely introduction](https://www.kysely.dev/docs/intro)
- [Skeleton React layouts](https://www.skeleton.dev/docs/react/guides/layouts)
- [Skeleton React installation](https://www.skeleton.dev/docs/react/get-started/installation/vite-react)
