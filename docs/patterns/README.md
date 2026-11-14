# Package boundaries and patterns

For contributors deciding where controller code belongs. Keep this index and
its example paths current whenever a boundary or pattern changes.

## Established patterns

| Concern             | Pattern and example                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI and HTTP hosting | One TanStack Start React app, built for Bun through Nitro: `apps/controller/vite.config.ts`.                                                                                                                                                                                                                                                                                                    |
| API transport       | Elysia 2 RC's fetch handler is mounted in `apps/controller/src/routes/api.$.ts`. It owns no listener.                                                                                                                                                                                                                                                                                           |
| Services            | Framework-free functions in `packages/services/src`: the role matrix (`authorization.ts`, the only source of organization authorization), organizations, members, projects and API keys (`api-keys.ts`). Every function takes the caller (`Principal`) and organization; non-members get not-found. Handlers and server functions delegate to them. Do not import Elysia, React, or Start here. |
| SQL and migrations  | Kysely on Bun's native SQL client (`BunSqlDialect`), one instance shared with Better Auth, explicitly constructed in `packages/database/src/index.ts`; forward-only migrations in `packages/database/src/migrations`, run only by the explicit admin command.                                                                                                                                   |
| Organization API    | `apps/controller/src/server/api.ts` maps `ServiceError` codes to statuses (`respond`). Better Auth's `/api/auth/organization/*` is blocked there; organization changes only go through our services. Pages read via `src/server/data.ts` server functions.                                                                                                                                      |
| API reference       | `@elysia/openapi` mounted last in `apps/controller/src/server/api.ts`; operations are described in `src/server/openapi.ts` from the zod schemas in `packages/services/src/contracts.ts`. Scalar's bundle is published from our own origin by `vite.config.ts`.                                                                                                                                  |
| Authentication      | Better Auth is built by `createAuth` in `packages/auth/src/create-auth.ts` from validated configuration; the Elysia adapter mounts it at `/api/auth` and guards cookie mutations by origin in `apps/controller/src/server/api.ts`. Start pages read the session through `apps/controller/src/server/session.ts`.                                                                                |
| Tasks               | Omni runs everything: presets in `omni/presets`, repository-wide tasks and `check:deps` in `tooling/`. Project dependencies are declared in both `package.json` and `project.omni.yaml`; cache keys name every input. See `docs/tooling.md`.                                                                                                                                                    |
| Email               | `Mailer` in `packages/auth/src/mailer.ts` (nodemailer; plain SMTP only to loopback). Invitations live in `packages/services/src/invitations.ts`; tests use the in-process `@launchpad/auth/testing` fake SMTP server.                                                                                                                                                                           |
| Contracts and SDK   | `packages/contracts` holds the API's roles, key scopes, input and response schemas (zod only, browser-safe); services and the OpenAPI document import them. `packages/sdk` is the bearer-key HTTP client built on them. `packages/client-core` adds profiles and the credential file for the CLI and MCP.                                                                                       |
| Dokku               | Only connection types in `packages/dokku/src/index.ts`. There is no SSH executor or deployment behavior yet.                                                                                                                                                                                                                                                                                    |
| UI styling          | Skeleton 5 and Tailwind 4 imports in `apps/controller/src/styles.css`; semantic HTML and body scrolling in `src/routes/__root.tsx` and `index.tsx`.                                                                                                                                                                                                                                             |
| CLI                 | Bun entry in `apps/cli/src/index.ts`, limited to help/version. It will consume the controller, not invoke Dokku directly.                                                                                                                                                                                                                                                                       |
| Testing             | Unit tests need no infrastructure and call `api.fetch(Request)`. Integration tests (`*.spec.ts` in `__tests__`) use a disposable PostgreSQL via `@launchpad/database/testing`; `apps/controller/src/__tests__/hop.spec.ts` drives the built server over HTTP.                                                                                                                                   |

The health endpoint reports static metadata, not PostgreSQL/Dokku readiness.
Operator login, organizations, members and projects exist, but there are no
deployments yet: do not publicly expose the controller as a management system.

## Approved direction, not yet implemented

The controller will use PostgreSQL for metadata and SSH for privileged Dokku
operations. Application services should depend on narrow repository/adapter
interfaces rather than HTTP framework objects. Implement those interfaces when
the first real feature needs them, not as speculative generic abstractions.

Jobs, uploads, organizations, SMTP modes, SSH host-key verification, and app
resource lifecycle still require design and security review before real use.

## References

- [Elysia / TanStack Start integration](https://elysiajs.com/integrations/tanstack-start)
- [TanStack Start Bun hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting#bun)
- [Kysely introduction](https://www.kysely.dev/docs/intro)
- [Skeleton React layouts](https://www.skeleton.dev/docs/react/guides/layouts)
- [Skeleton React installation](https://www.skeleton.dev/docs/react/get-started/installation/vite-react)
