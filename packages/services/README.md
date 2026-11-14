# Services

For contributors implementing controller use cases. Keep this page current
when the service boundary changes.

Framework-independent application logic lives here: the organization role matrix
(`authorization.ts`, the only source of organization authorization), organizations
and members, projects, email invitations, typed `ServiceError`s, and the API
response contracts (`contracts.ts`). Every function takes the caller (a
`Principal`) and the organization, validates input with zod, and treats
non-members as not-found. Elysia handlers and TanStack server functions delegate
to services, not the other way around.

Integration tests (`omni -i run test:integration`) need a disposable PostgreSQL; see
[CONTRIBUTING.md](../../CONTRIBUTING.md) and [patterns](../../docs/patterns/README.md).
