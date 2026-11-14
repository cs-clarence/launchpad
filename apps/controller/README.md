# Controller

For contributors to the TanStack Start dashboard and Elysia HTTP adapter.
Keep this page current when the entry points or runtime change.

- `src/routes/api.$.ts` mounts `src/server/api.ts` without starting another server.
- Services live in `@launchpad/services`, outside HTTP and UI frameworks.
- `src/styles.css` installs Skeleton 5, Tailwind 4, and the Cerberus theme.
- `Dockerfile` produces a non-root Bun runtime from Nitro's build output.
- `src/server/runtime.ts` composes configuration, the shared Kysely database,
  Better Auth and the API on first use.
- `src/admin/main.ts` is the operator command, run through Omni (see First run). Omni
  loads `apps/controller/.env.local` (copy `.env.local.example`) into `dev` and `admin`.

## Configuration

| Variable                  | Meaning                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`            | PostgreSQL connection string (required)                                                                                                                                                                |
| `LAUNCHPAD_AUTH_SECRET`   | Random secret, at least 32 characters (required)                                                                                                                                                       |
| `LAUNCHPAD_BASE_URL`      | Public controller URL; its origin is the only trusted origin (required)                                                                                                                                |
| `LAUNCHPAD_ENROLLMENT`    | `operator` (default) or `invitation` (requires SMTP)                                                                                                                                                   |
| `LAUNCHPAD_PUBLIC_SIGNUP` | `false` by default; sign-up is a separate policy from SMTP                                                                                                                                             |
| `LAUNCHPAD_SMTP_URL`      | Optional; set with `LAUNCHPAD_EMAIL_FROM` to enable email recovery and invitations. `smtps://` or `smtp://` (STARTTLS required unless loopback); no query options                                      |
| `HOST` / `PORT`           | Listen address and port of the built server (default `127.0.0.1`-style host, port `3000`)                                                                                                              |
| `LAUNCHPAD_API_DOCS`      | `true` (default) serves the OpenAPI document and Scalar reference; `false` removes them                                                                                                                |
| `LAUNCHPAD_TRUSTED_PROXY` | `false` (default): the TCP peer address is the client address. `true`: exactly one trusted proxy that appends to `X-Forwarded-For`; its rightmost entry is used. Never set `true` without such a proxy |

## API reference

The public `/api/v1` API is described by an OpenAPI 3.1 document at
`/api/openapi/json`, with a Scalar reference at `/api/openapi`. The reference is
generated from the same zod schemas the services validate with
(`packages/services/src/contracts.ts`, plus each service's input schema), and
integration tests parse live responses with those schemas, so documentation
cannot drift from behaviour. Scalar's script is published from this origin from
the pinned `@scalar/api-reference` package (`vite.config.ts`); no third-party
script runs next to the session cookie. Better Auth's `/api/auth/*` endpoints are
not part of the document.

To document a new route, add an entry to `docs` in `src/server/openapi.ts` and pass it as
the route's `detail`. In Elysia 2 RC the hook goes **before** the handler:
`.get(path, { detail: docs.x }, handler)`; the legacy handler-first order throws.

## First run

Copy `.env.local.example` to `.env.local` here and edit it; Omni loads it for `dev` and
`admin`. Take a `pg_dump` before every migrate: migrations are forward-only, so rolling
back means stopping the controller and restoring the dump. Stopping management access
never touches Dokku workloads.

Operator commands run as an Omni task whose command and options are named arguments.
Passwords come from a file only you can read (mode 600) or from piped stdin, never from
an argument or the environment. Omni does not forward piped stdin, so use a file:

```sh
omni -i run admin -p @launchpad/controller -a command=migrate           # forward-only, explicit
omni -i run admin -p @launchpad/controller -a command=setup \
  -a "options=--email you@example.com --password-file /run/secrets/launchpad-operator"
omni -i run dev -p @launchpad/controller                                 # dev server
```

Run directly, from this directory, the same commands are `bun run admin migrate` and
`pass show launchpad/operator | bun run admin setup --email you@example.com`.

Sign-in is throttled per client and email, and per email across clients (so someone
who knows an address can temporarily lock that account out of sign-in; this is an
accepted trade-off); Better Auth
also limits each client address. `setup` creates the one instance operator, once, with the password from stdin.
`reset-password --email <email>` (new password from `--password-file` or stdin) is the
local recovery path: it replaces the password, revokes all of that user's
sessions and writes an audit event. It is a host command, not an HTTP endpoint.
The controller never migrates on startup. There is no default password.
Provision people and organizations offline:

```sh
omni -i run admin -p @launchpad/controller -a command=create-user \
  -a "options=--email ann@example.com --name Ann --password-file /run/secrets/ann"
```

Then sign in as the operator and create an organization in the dashboard, naming
an existing user as its first owner. The operator gets no access inside the
organization; owners and admins add existing users by email. Roles are `owner`,
`admin`, `deployer` and `viewer` (see
[the decision](../../docs/decisions/organization-roles-and-operator-access.md)).

Access granted by email (an organization's owner, or a member added by address) only goes to
an account whose address was verified or that the operator provisioned, never to one that
registered itself. This does not depend on the current `LAUNCHPAD_PUBLIC_SIGNUP` value, so
turning sign-up off does not make accounts registered earlier any more trustworthy; invite
such an address instead.

### Email (optional)

With `LAUNCHPAD_SMTP_URL` and `LAUNCHPAD_EMAIL_FROM` set, a forgot-password page
appears and password reset mail is sent, but only to addresses that are
**verified**. An address becomes verified when its owner accepts an emailed
invitation; operator-provisioned addresses stay unverified and are recovered with
`reset-password`. With `LAUNCHPAD_ENROLLMENT=invitation`, owners and
admins invite people by email (7-day, single-use link; only a hash is stored). A
new person creates their own account from the link; an existing user must be
signed in as the invited address. SMTP alone enables neither invitations nor
public sign-up. Turning email on or off never changes accounts, memberships or
sessions. If mail cannot be sent, an invitation is revoked and the API returns 502.

Run checks from the repository root as described in
[CONTRIBUTING.md](../../CONTRIBUTING.md). Milestone 1's independent security review is
complete; keep `LAUNCHPAD_API_DOCS=false` on internet-facing installs unless you want
the API shape public, and put the controller behind HTTPS before exposing it.
