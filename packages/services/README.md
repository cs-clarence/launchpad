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

## API-key lifecycle metadata

`listApiKeys` returns a server-computed `status`: `revoked` takes precedence over
`expired`, then `inactive` (the creator's original membership was removed), then
`active`. Re-adding the creator does not revive the old key or change its inactive
status. Only unrevoked, unexpired keys with their original membership still present
count toward the 100-active-key cap.

Active is a lifecycle label, not a permission guarantee: scopes are still narrowed
to the creator's current role on every use. The additive `status` field is required
by the workspace's response contract; strict consumers must update with the
controller. These packages are not published yet. No secret, secret hash or
internal membership identifier is returned in a key summary.
