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

## Artifacts (milestone 3, slice 2)

`archive.ts` validates a `.tar.gz` without extracting it (see the controller README
for the rules); `artifacts.ts` streams an upload to a private staging file under byte
and time limits, validates it, and finalizes it atomically under a per-organization
lock. The caller is authorized before the first byte is read and re-checked under
the lock. Storage keys are exactly `artifacts/<32 hex>/<64 hex>.tar.gz` (a hash of
the organization, then the archive digest); `resolveArtifactPath` refuses anything
else. Test archives (including hostile ones) are built by `@launchpad-kit/services/testing`.

## Status and recovery

`status.ts` reports database readiness and stored artifacts to the instance operator.

`deployment-recovery.ts` owns the model-mutation gate. `withModelMutation` holds a shared
recovery lock, checks the filesystem/database gate and fsyncs `model-writer-seen` before
the callback can mutate or dispatch. Restore/clear use the exclusive lock. Artifact publication
and collection use this gate. `clearDeploymentRecovery` checks external evidence and the
restored model, waits for the stop grace, and requires the operator's Dokku host confirmation.
It never uses `model-writer-seen` to waive verification. Auth/organization/key administration does
not use this gate. See [recovery design](../../docs/design/deployment-cutover-schema.md#restore-and-the-recovery-gate).
