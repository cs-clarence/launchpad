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

## Previews (milestone 3, slice 1)

`previews.ts` creates and reads preview records only: nothing is deployed and Dokku
is not contacted. Names that reach Dokku (`app_name`, `lp-` plus ten random
characters) are generated, never derived from user input; the hostname is
`<slug>-<six random characters>.<preview domain>`. Creation is serialized per
organization, enforces the live-preview cap (default 10) and supports an
idempotency key bound to organization, principal and endpoint. The database
refuses cross-organization references and more than one unfinished deployment
per preview. Viewers read previews; deployers and above create and deploy.
