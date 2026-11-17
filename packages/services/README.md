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

`listPreviews` pages with a keyset cursor (the last id of the previous page, returned as `nextCursor`), so every preview within the cap is reachable. A deployment can only be made active for the preview it belongs to, and `maxPreviews` must be a positive integer.

## Artifacts (milestone 3, slice 2)

`archive.ts` validates a `.tar.gz` without extracting it (see the controller README
for the rules); `artifacts.ts` streams an upload to a private staging file under byte
and time limits, validates it, and finalizes it atomically under a per-organization
lock. The caller is authorized before the first byte is read and re-checked under
the lock. Storage keys are exactly `artifacts/<32 hex>/<64 hex>.tar.gz` (a hash of
the organization, then the archive digest); `resolveArtifactPath` refuses anything
else. Test archives (including hostile ones) are built by `@launchpad/services/testing`.

## Deployments, lifecycle and status (milestones 3 to 5)

See [patterns](../../docs/patterns/README.md) for the file map. In short: `deployments.ts` is the
queue, the lease and the state machine for a deployment (`enqueueDeployment`, `claimNext`,
`runDeployment`, `resolveReconciliation`); `expiry.ts`, `deletions.ts`, `artifact-gc.ts` and
`lifecycle-run.ts` are expiry, the deletion operation (fenced, with an ownership pattern for what it
may destroy), artifact collection and one round of lifecycle work for the worker; `deadline.ts` is
the lease deadline (monotonic and wall clock); `status.ts` is the worker heartbeat and the
operator-only status. Everything that destroys is off unless the lifecycle is on, and every write
by a worker is fenced so a stale worker cannot record anything. Each has integration tests against
a disposable PostgreSQL, with fakes for the Dokku and Docker ports; the worker's opt-in live suite
covers the real ones.
