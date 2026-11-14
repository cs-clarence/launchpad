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
- Covers what a key may do: key info, own organization, members (read), projects (list, create). Key, member and invitation management are session-only in the API and are not in the SDK.

Depends on `zod` and `@launchpad/contracts` only; no filesystem or credential storage (see `@launchpad/client-core`).
