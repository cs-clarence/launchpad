# @launchpad-kit/sdk

Browser-safe HTTP SDK for the controller API, authenticated with an organization API key.

```ts
import { createClient } from "@launchpad-kit/sdk";

const client = createClient({
    baseUrl: "https://control.example.com",
    apiKey: process.env.LAUNCHPAD_API_KEY!,
});
const key = await client.key.get();
const projects = await client.projects.list(key.organizationId);
```

- Only `https` (or `http` to loopback) base URLs; the key is sent as a bearer token, never with cookies, and redirects are refused so it cannot be forwarded.
- Responses are checked against `@launchpad-kit/contracts` but tolerate fields a newer controller adds. Errors are `LaunchpadApiError` (the controller answered with an error status; `code` may be a code this version does not know), `LaunchpadTransportError` (unreachable, timeout, redirect, unexpected answer) or `LaunchpadConfigError`. None contains the key or a response body.
- Covers key info, own organization, members (read), projects, artifacts, apps, deployments and
  aliases. Reconciliation requests, key, member and invitation management are session-only and
  are not in the SDK. There is no legacy preview client.

```ts
// `archive` is a Blob of .tar.gz bytes; `projectId`, `appId` and `aliasId` are exact IDs.
const org = key.organizationId;
const artifact = await client.artifacts.upload(org, projectId, archive);
const deployment = await client.deployments.create(org, appId, { artifactId: artifact.id });
// The above only queues a deployment. Wait for deployments.get(...) to report "succeeded".
const alias = await client.aliases.get(org, aliasId);
const operation = await client.aliases.promote(
    org,
    alias.id,
    { targetDeploymentId: deployment.id, expectedGeneration: alias.reservedGeneration },
    { idempotencyKey: "release-42" },
);
// Read client.aliases.operations(org, aliasId) for the result; queued does not mean routed.
```

Use the last read **reserved** generation (a string, never a number). A stale generation
conflicts. Use the same idempotency key for retries of the exact same routing intent.
Roll back by promoting a different retained deployment. Deploy and promote need separate scopes.

Depends on `zod` and `@launchpad-kit/contracts` only; no filesystem or credential storage (see `@launchpad-kit/client-core`).
