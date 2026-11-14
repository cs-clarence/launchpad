# Milestone 0 spike results and queue choice

Status: partial; the spikes listed under Deferred gates are outstanding. For
contributors starting milestone 1. The spike code was throwaway, used hardcoded throwaway credentials, and lives
outside the repository; the credentials and resources are destroyed.
Observations below were measured on 2026-11-14 with the versions listed.

## Versions exercised

Better Auth and `@better-auth/api-key` 1.7.23, Elysia 2.0.0-rc.3, Kysely 0.29.9,
`pg` 8.23.1, pg-boss 12.38.2, PostgreSQL 17, Dokku 0.38.34, Bun 1.4.4.

## Findings

### Better Auth, Elysia and PostgreSQL

- Observed: mounting `auth.handler` in Elysia works. Email/password sign-up sets
  a session cookie, and `auth.api.getSession` identifies the user on a product route.
- Observed: organization creation works. `verifyApiKey` returns the key's owning
  organization (`referenceId`). Better Auth does not enforce organization
  scoping; the route must compare it with the target organization (the spike's
  own check returned 403 cross-org). Milestones 1 and 2 must centralize that
  check for every org-scoped route. Not tested: which members may create
  organization keys.
- Observed: with `enableSessionForAPIKeys` off, a key on a session-only route
  gets 401.
- Observed: `getMigrations` exposes `compileMigrations` (not exercised). The SQL
  was not reviewed; it was applied with `runMigrations`.
- Observed: sign-up is open unless `disableSignUp` is set, and any user can create
  organizations by default. Milestone 1 must default to `disableSignUp: true` and
  restrict organization creation to operators, per
  [identity provisioning](configurable-identity-provisioning.md), and test that
  both are denied.
- Not tested: the full TanStack Start to Elysia hop (the spike used Elysia
  directly), body and stream handling, the SMTP modes, and a shared Kysely
  instance with the auth pool.

### Queue: choose pg-boss

- Observed: a job sent inside a rolled-back transaction does not exist. Sent in a
  committed transaction, it does.
- Observed: a `stately` queue rejects a second job with the same `singletonKey`.
- Observed: after lease expiry an unfinished job returns to `retry` and can be
  fetched again (same process; supervision intervals shortened; `retryLimit: 2`).
  The original worker is not stopped, so two attempts can run concurrently.
  `stately` permits one queued plus one active job per key; it is not
  per-preview mutual exclusion. Milestone 3 must add an attempt/fencing token
  checked on every state write and Dokku call, per-preview serialization, and
  Dokku reconciliation before re-running.
- Not tested: scheduling, Bun worker death mid-job, and a separate worker process.

Decision: use pg-boss for durable jobs. Revisit if milestone 3 cannot fence stale
attempts or keep leases longer than worst-case deploy duration.

### Worker to Dokku over SSH

- The pinned key was read from the Dokku container's own `ssh_host_ed25519_key.pub`
  (out of band, not keyscan). Production must provision `known_hosts` the same way,
  never scan at runtime, and use `StrictHostKeyChecking=yes`, `BatchMode=yes`,
  `IdentitiesOnly=yes`. The results below were observed manually; no transcript
  was kept.
- Observed: a pinned host key works. A different host key, missing credentials and
  an arbitrary shell command (`ls /`) all fail closed.
- Observed: from a container on the Docker bridge, SSH to the Dokku container's
  address works with the pinned key. The published `127.0.0.1` port is not
  reachable from containers, so the worker needs a shared Docker network.
- Observed: a fixed Nginx template image streamed with `git:load-image` deployed
  to a disposable app. `/` returned 200 and an unknown path returned a real 404.
- Not tested: SPA fallback, proxy readiness probing, timeout after a successful
  remote change. These remain milestone 3 gates.

### Gate status after milestone 1 slices 1–4

- Closed: the Start→Elysia session cookie, JSON body and sign-out path, and
  Better Auth and Launchpad queries sharing one Kysely instance on Bun SQL, are
  covered by `apps/controller/src/__tests__/hop.spec.ts` and
  `packages/auth/src/__tests__`. The auth schema SQL was reviewed and frozen in
  `packages/database/src/migrations/auth-schema.ts`: tables user, session, account,
  verification, organization, member, invitation and rateLimit, all with
  `timestamptz`, foreign keys with cascade deletes, and indexes on foreign keys.
- Still open: multipart bodies and streamed responses through the hop (no upload
  endpoint exists yet; due with milestone 3 uploads).

### Deferred gates (original)

- Before milestone 1: Start→Elysia session cookies, request bodies and streams;
  Kysely and auth sharing one pool; auth migration SQL review.
- Before milestone 3: scheduling and Bun worker death; a worker container
  reaching Dokku on a shared network; worker image build; bounded progress
  through the intended ingress.

### Controller image

- Observed: the existing recipe builds from the repository root, runs as the
  `bun` user, and serves the page and `/api`. It has no health or migration step.

## Cleanup

Disposable PostgreSQL container, the `lp-spike` Dokku app, its SSH key and the spike
images were removed. `view-demo` and `.data/dokku` were not changed. Dokku was
stopped again after the spike.
