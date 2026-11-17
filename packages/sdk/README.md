# @launchpad/sdk

Browser-safe HTTP SDK for the controller API, authenticated with an organization API key.

```ts
import { createClient } from "@launchpad/sdk";

const client = createClient({
    baseUrl: "https://control.example.com",
    apiKey: process.env.LAUNCHPAD_API_KEY!,
});
const key = await client.key.get();
const projects = await client.projects.list(key.organizationId);
```

- Only `https` (or `http` to loopback) base URLs; the key is sent as a bearer token, never with cookies, and redirects are refused so it cannot be forwarded.
- Responses are checked against `@launchpad/contracts` but tolerate fields a newer controller adds. Errors are `LaunchpadApiError` (the controller answered with an error status; `code` may be a code this version does not know), `LaunchpadTransportError` (unreachable, timeout, redirect, unexpected answer) or `LaunchpadConfigError`. None contains the key or a response body.
- Covers what a key may do: key info, own organization, members (read), projects (list, create), uploads, previews, deployments and deletion status. Key, member and invitation management and reconciliation are session-only in the API and are not in the SDK.

Depends on `zod` and `@launchpad/contracts` only; no filesystem or credential storage (see `@launchpad/client-core`).

## Preview lifecycles

- `client.previews.create(orgId, projectId, { slug, ttl: "24h" })` chooses a lifetime.
- `client.previews.extend(orgId, previewId, { ttl: "24h" }, { idempotencyKey })` returns
  the resulting preview without extending again on a retry with that key. Requires
  `preview:deploy`. A replay returns the current preview, which may differ from the original
  response after another extension. Extending a never-expiring preview with a duration gives it an expiry.
- `client.previews.delete(orgId, previewId)` queues deletion and returns
  `{ operationId, state: "deleting" }`. Requires `preview:delete`, and deployments and the lifecycle turned on in the controller and the worker.
  Repeating while deleting returns the same operation; after deletion it is 404.
- `client.deletions.forPreview(orgId, previewId)` finds a preview's latest deletion, whoever
  started it. `client.deletions.get(orgId, operationId)` polls the operation with `preview:read`.
  `reconciliation-needed` requires an administrator's session; resolution is intentionally
  not exposed by this bearer-only SDK.

These calls accept `{ signal }` as their final options argument. Project-limited keys
can reach only previews and deletion operations in their allowed projects. See the
[controller reference](../../apps/controller/README.md#preview-lifecycle-api) for states,
errors and [what deletion keeps](../../apps/controller/README.md#what-deletion-keeps-and-what-is-not-here-yet).

## Transport verification

`omni -i run test:integration -p @launchpad/sdk` exercises real fetch with temporary
HTTP fixtures on `127.0.0.1` and OS-assigned ports. It verifies that 302/307/308
redirects are rejected without reaching another origin or forwarding its bearer
key, and that a body stalled after response headers is aborted by the SDK timeout.
Every fixture is closed after its test, including failure paths. This suite needs
no controller, database or external service.

Run it under Node as well as Bun when changing transport behavior; fetch error
messages differ between runtimes, so redirect rejection may surface as either a
redirect or an unreachable-controller transport error. Unit tests remain separate
and do not open listeners.
