# Package boundaries and patterns

For contributors deciding where controller code belongs. Keep this index and
its example paths current whenever a boundary or pattern changes.

## Established by the scaffold

| Concern             | Pattern and example                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI and HTTP hosting | One TanStack Start React app, built for Bun through Nitro: `apps/controller/vite.config.ts`.                                                                                                  |
| API transport       | Elysia 2 RC's fetch handler is mounted in `apps/controller/src/routes/api.$.ts`. It owns no listener.                                                                                         |
| Services            | Framework-free functions in `packages/services/src/index.ts`; API handlers delegate to them. Do not import Elysia, React, or Start here.                                                      |
| SQL                 | Kysely's PostgreSQL dialect with `pg`, explicitly constructed in `packages/database/src/index.ts`. No schema, queries, or import-time connections. Call `destroy()` during eventual shutdown. |
| Dokku               | Only connection types in `packages/dokku/src/index.ts`. There is no SSH executor or deployment behavior yet.                                                                                  |
| UI styling          | Skeleton 5 and Tailwind 4 imports in `apps/controller/src/styles.css`; semantic HTML and body scrolling in `src/routes/__root.tsx` and `index.tsx`.                                           |
| CLI                 | Bun entry in `apps/cli/src/index.ts`, limited to help/version. It will consume the controller, not invoke Dokku directly.                                                                     |
| Testing             | Services are tested without HTTP; API tests call `api.fetch(Request)` without listening on a port.                                                                                            |

The health endpoint reports scaffold metadata, not PostgreSQL/Dokku readiness.
There is no authentication: do not publicly expose the controller as a
management system.

## Approved direction, not yet implemented

The controller will use PostgreSQL for metadata and SSH for privileged Dokku
operations. Application services should depend on narrow repository/adapter
interfaces rather than HTTP framework objects. Implement those interfaces when
the first real feature needs them, not as speculative generic abstractions.

Jobs, uploads, auth, schema/migrations, SSH host-key verification, and app
resource lifecycle still require design and security review before real use.

## References

- [Elysia / TanStack Start integration](https://elysiajs.com/integrations/tanstack-start)
- [TanStack Start Bun hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting#bun)
- [Kysely introduction](https://www.kysely.dev/docs/intro)
- [Skeleton React layouts](https://www.skeleton.dev/docs/react/guides/layouts)
- [Skeleton React installation](https://www.skeleton.dev/docs/react/get-started/installation/vite-react)
