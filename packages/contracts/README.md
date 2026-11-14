# @launchpad/contracts

The versioned shapes of the controller's public HTTP API: roles, API-key scopes, input schemas a client builds and every response. Zod only.

Browser-safe: no Node, Bun, database or framework imports (a test enforces this). The controller documents and tests against these same schemas (`apps/controller/src/server/openapi.ts`, `hop.spec.ts`), so the API reference cannot drift from behaviour. `@launchpad/services` re-exports them for the controller.

Depends on `zod` only. Used by `@launchpad/services`, `@launchpad/sdk` and `@launchpad/client-core`.
