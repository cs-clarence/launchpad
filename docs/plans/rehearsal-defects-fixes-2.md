# Fixes for the defects found in the DB, worker and restore rehearsals, second PR

Status: **implemented on `fix/rehearsal-defects-second` (see "Implementation notes" at the end); all decisions taken (revision 2).** Planned against `origin/main` at `730f0fa`; built on `668b1df`.
Source: the "Defects and follow-ups" table in `docs/plans/evidence/rehearsal-db-worker-restore-20261126/README.md`
(transcripts `04`, `05`, `08`, `09`, `10`). The first PR (#2, #4, #6, #7) is #105 (`fix/rehearsal-defects-first`); its plan,
`docs/plans/rehearsal-defects-fixes.md`, exists only on that branch. This file replaces its "Second PR" sketches.

## Decisions (user)

1. **One PR** for #1, #3, #5, #8, with ordered slices and commit boundaries inside it.
2. The controller's schema re-check window defaults to 10 s and is **configurable**.
3. **Liveness and readiness are separate.** `/api/health` stays liveness (does not depend on the database); a new
   `/api/ready` is readiness.
4. Worker identity: a **stable name** is the key; a per-process **run id** and `started_at` are updated in place on every
   start; stale rows are pruned after a configurable age.
5. Heartbeat beat, stale and expiring thresholds are all configurable and validated.
6. The dashboard's server functions map database problems to a clear UI state **in this PR**.
7. `stopped_at` is kept, state derived from columns.
8. Earlier decisions stand: #1 heartbeat table row in the operator-only `GET /api/v1/status`, warnings when stale and when a
   lease is expiring or expired with no live worker, Compose keeps `restart: unless-stopped` (documented); #3 the
   controller detects a replaced, unreachable or schema-behind database itself and answers 503 `schema-mismatch` or a
   stable `database-unavailable` instead of a raw 500; #5 healthcheck semantics unchanged (documented); #8 docs only.

## Assessment

- **Kind: large. Risk tier: high.** One PR carries a forward-only migration (undone only by restoring a backup:
  `docs/upgrade.md`), a new public error code and a new public endpoint, an extra check on the controller's request path
  that can take the API to 503 if it is wrong, a worker change, new settings in two processes and the dashboard. About 1,500
  to 2,000 lines with tests across `packages/{database,contracts,services}`, `apps/{controller,worker}` and docs.
- Four questions: change is large (above); unknowns are moderate (Bun SQL error shapes, TanStack Start server-function error
  transport, Elysia `onError` ordering: bounded spikes at the start, below); hard to undo for the migration only (easy to
  revert everything else; the migration is additive and its undo is a backup restore); one author, one independent reviewer.
- Why one large PR is acceptable here and what makes it reviewable: the slices below each compile, test and pass `check`
  alone, in the order of risk (no schema first, the migration late), with their own commit; the migration slice is
  isolated in its own commit so it can be reviewed first by whoever owns the schema. If review shows the slices cannot
  stay independent, or the dashboard spike (slice 6) reveals a larger rework, stop and ask (`core/when-to-ask.md`): the
  fallback is to cut slices 4 to 6 into a follow-up PR; slices 1 to 3 stand alone.
- Execution: solo author, slices in order, no agent split (they share `api.ts`, `contracts`, `status.ts`). **Independent
  review is required at the gate below**, the author does not review their own migration.

## Dependency on PR #105 (must merge first)

- No code dependency: #105 touches `apps/controller/src/admin/{main,preflight}.ts`, `packages/services/src/artifacts.ts`,
  `tooling/local-*.ts`, `tooling/compose-production.spec.ts`, `docs/{local-deploy,restore,production-compose}.md`,
  `apps/controller/README.md`. This PR touches the same three docs and `apps/controller/README.md` in other places, plus
  `docker-compose.yaml`, `docker-compose.env.example` and `tooling/compose-production.spec.ts`.
- **Order:** #105 merges first. Then branch from the new `origin/main` (or rebase the work branch onto it) before the first
  commit, so `docs/plans/rehearsal-defects-fixes.md` exists (its status line and "Second PR" section get updated in slice 7)
  and the shared doc and spec hunks do not conflict. Rebase again before opening the PR. Nothing in the slices needs #105's
  code, so planning and spikes can start now.

## What the code does today (read, not assumed)

- `apps/controller/src/server/runtime.ts` `getReadyRuntime`: one `assertSchemaCurrent` plus `requireModelDataDirectory`;
  **a passed check is cached forever**, a failed one is retried every 3 s (`RECHECK_AFTER_MS`), shared by concurrent callers.
  Hence a database replaced under a running controller is not noticed until restart (#3).
- `apps/controller/src/routes/api.$.ts`: turns only `SchemaMismatchError` from `getReadyRuntime` into
  `503 { code: "schema-mismatch", status: 503, title: "Service Unavailable" }` for every `/api/**` request **including
  `/api/health`**; other errors are rethrown (raw 500). `GET /api/health` itself (`getControllerInfo` in
  `packages/services/src/index.ts`) never touches the database; the docs and compose use it as the controller's healthcheck.
- `apps/controller/src/server/api.ts` `execute()` maps `ServiceError`/`DeploymentRecoveryError`, else `500 internal`.
  `callerOf` (key lookup, `auth.api.getSession`), `sessionPrincipal`, `throttleSignIn`, `respondPublic` and `/auth/*` reach the
  database outside `execute`, so a database failure there is Elysia's raw 500.
- `packages/contracts` `errorSchema.code` is a closed enum, missing `schema-mismatch` which is already emitted.
  `packages/sdk/src/transport.ts` (~254) reads `code` by hand as a string, so new codes are backward compatible.
  No first-party client reads `/api/v1/status` or parses `statusSchema` (only `apps/controller/src/server/{api,openapi}.ts`,
  `packages/services/src/{status,contracts}.ts`, tests).
- **Dashboard:** `apps/controller/src/server/data.ts`, `session.ts` (TanStack Start `createServerFn`) call `getReadyRuntime()`
  first and then services; they are not routed through the API adapter, so a `SchemaMismatchError` or a database error
  becomes a thrown `Error` (a raw 500). Routes: `__root.tsx` has no `errorComponent`; `router.tsx` has no
  `defaultErrorComponent`; `orgs.$orgId.tsx` has an `errorComponent` that says **"Organization not found." for every error**
  (wrong for a database outage); loaders/`beforeLoad` in `index.tsx`, `login.tsx`, `orgs.$orgId.tsx`, `accept-invitation.tsx`,
  `forgot-password.tsx` call `getCurrentUser`, `getFeaturesFn`, `listOrganizationsFn`, `getOrganizationViewFn`,
  `getInvitationPreviewFn`. Browser actions use `apiRequest`/`apiCall` in `lib/api.ts`, which show `problem.title` or
  "The request failed." (these already work through `/api` and benefit from the API mapping). There is no component test
  infrastructure in the controller (no jsdom/testing-library in `package.json`).
- Settings conventions: parsed in `packages/services/src/*-config.ts` with small helpers (`integer(env, name, fallback, max)`,
  `parseDuration` from `@launchpad-kit/contracts`, `duration(name, fallback, max)` in `parseDeploymentConfig`), throwing
  `"<NAME> must be ..."`; `assertCurrentSettings` refuses removed names; the controller validates at startup in
  `apps/controller/src/server/startup-settings.ts` (a Nitro plugin) and the worker at start in `index.ts`; compose passes
  them in `docker-compose.yaml` (`x-shared` YAML anchor for the shared ones; `LAUNCHPAD_API_DOCS` on the controller,
  `LAUNCHPAD_WORKER_ID` on the worker); documented in `docker-compose.env.example`, `apps/*/.env.local.example`,
  `apps/controller/README.md` (settings table), `docs/production-compose.md`; `tooling/compose-production.spec.ts` guards
  the compose environment. `docs/tooling.md` does not list settings (it covers tools); it only needs a change if a command
  or generator changes, so no edit there unless `check:compose` grows a rule.
- Worker identity today: `LAUNCHPAD_WORKER_ID` (`apps/worker/src/worker-id.ts`: 1 to 64 chars `[A-Za-z0-9][A-Za-z0-9._-]*`; empty means
  `randomUUID()` per process) is the `owner` recorded as `lease_owner` and in logs. Compose sets `hostname: launchpad-worker`
  on the worker (the comment says it identifies it in logs) and passes `LAUNCHPAD_WORKER_ID` empty by default.
- Worker loop: pool `max: 2`, statement timeout 5 s; every DB call within an 8 s `database()` deadline that aborts the
  worker on expiry; `markHealthy()` after claims and renewals; the lease guard renews every 2 s while a run is in flight
  (`lease-guard.ts`, `HEARTBEAT_MS = 2000`) and refuses to act within a 10 s margin of the 300 s lease
  (`DEPLOYMENT_LEASE_MS = 300_000`, not configurable). With deployments off the worker never opens the database.
- `getStatus` (`packages/services/src/status.ts`): operator-only, counts only, `warnings: []` always.
- Migrations: one file per migration in `packages/database/src/migrations/`, forward-only, only `20261124_001_initial_schema.ts`
  exists. **The schema-rollback gate** is `assertKnownHistory` in `migrate.ts`: a build that does not know an applied
  migration refuses (`SchemaMismatchError`), and `restore` refuses a backup holding unknown migrations.

## Design

### A. Errors and the shared database check (#3)

1. **Classifier** `classifyDatabaseError(error): "unreachable" | "schema" | null` in `packages/database/src/errors.ts`
   (exported with `SchemaMismatchError`): "unreachable" = connection closed/refused/timeout/DNS (Bun SQL error codes and
   SQLSTATE class `08`, `57P01`, `57P03`, `53300`); "schema" = `42P01` and `42703`; anything else `null` (stays `internal`).
   The fixtures come from a spike (Unknowns 1), not guesses.
2. **One shared gate**, extracted from `runtime.ts` as a pure `createSchemaGate({ check, now, intervalMs, retryMs })` (unit
   testable with a fake clock). `check` runs in **two stages** and the gate reports an explicit outcome, so no caller has to
   interpret a thrown error:

    | Outcome                 | Cause                                                                                                              | HTTP / code on API routes                                                                     |
    | ----------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
    | `ok`                    | schema current and the data directory present                                                                      | request served                                                                                |
    | `schema-mismatch`       | stage 1: `SchemaMismatchError` (behind, unknown migrations, table missing)                                         | 503 `schema-mismatch` (unchanged shape)                                                       |
    | `database-unavailable`  | stage 1: error classified `unreachable`                                                                            | 503 `database-unavailable`, `retry-after: 5`                                                  |
    | `unavailable`           | stage 2: `requireModelDataDirectory` failed (mount missing or not a directory); this is **not** a database problem | 503 `unavailable` (already in `errorSchema.code`), title "The data directory is unavailable." |
    | `failed` (unclassified) | stage 1 or 2 threw something unrecognised (a configuration or programming error)                                   | API routes: rethrown, 500 as today; `/api/ready`: 503 `unavailable` (readiness never 500s)    |

    Today `requireModelDataDirectory` runs inside the same promise as `assertSchemaCurrent` (`runtime.ts:82-88`), so its failure was
    a raw rejection and a 500; the staged outcome fixes that. The gate is single-flight, caches an `ok` for `intervalMs`, retries any
    non-`ok` outcome after `retryMs` (3 s, as now) and has `invalidate()`. `getReadyRuntime`, `/api/ready`, `/api/health` and the
    server functions all use this one gate (no second check path, no extra queries). A request that hits `42P01` inside the
    window calls `invalidate()`.
    **A failing re-check of an expired pass fails closed, and that IS new behavior** (corrected rationale): today a pass is final
    (`runtime.ts:78-96`), so after start a database blip, a replaced database, or an NFS/mount blip on the data directory never rejects
    traffic; only a check that failed at start (or a previous failure) is retried. With the periodic check, a failing re-check answers the mapped
    503 until a check passes again (retried at most every 3 s) and the previous pass is not served on. This is decided (fail closed) and is
    **listed under "Behavior changes" in the PR description and release notes**, with the setting `LAUNCHPAD_SCHEMA_CHECK_INTERVAL=off` as the way
    back. `/api/health` is the exception (section B).
    **Stage 2 (data directory) scope, evaluated and recommended:** the data directory is a mount, not a database fact, and the upload path
    already checks it per request (`artifacts.ts:202`, `ServiceError unavailable`), so gating _all_ traffic on it every interval adds the most new
    failure surface for the least protection. **Recommendation: stage 2 runs on the first check (as today, so start-up behavior is unchanged)
    and for `/api/ready` (readiness reflects the mount), but the periodic traffic gate re-runs stage 1 only.** A data-directory blip after start
    then makes `/api/ready` answer 503 `unavailable` and uploads refuse with the existing `unavailable`, while other routes keep serving: the
    only new fail-closed behavior is the database check. (Implementation: `gate.check({ includeDataDir })`; readiness passes it, traffic does not
    after the first pass; the outcome table is unchanged.)
    **Hard deadline (hang protection, verified):** the controller pool is created with no options (`runtime.ts:34`, `createDatabase(requireEnv("DATABASE_URL"))`),
    so against a blackholed database (packets dropped, no RST) a connect or a query waits for the OS/driver timeout, and `getReadyRuntime`,
    `/api/ready` and `/api/health` would hang with it. Bun SQL (`BunSqlOptions` in `packages/database/src/bun-sql-dialect.ts`) supports `connectionTimeout`
    (seconds) and `connection` startup parameters such as `statement_timeout`, which the worker already uses (`apps/worker/src/index.ts`). Two layers:
    (a) **the gate's own hard deadline**, `LAUNCHPAD_SCHEMA_CHECK_TIMEOUT` (controller; default **4 s**, bounds 1 s to 30 s, same parser and startup validation
    as the interval; must be smaller than the interval unless the interval is `off`: refused otherwise, e.g. timeout 4 s with interval 3 s), enforced
    with a `Promise.race` against a timer so it holds even if the driver never returns; the outcome is `database-unavailable`; (b) **pool defaults on the
    controller**: `connectionTimeout: 5` (seconds; bounds how long any request waits for a connection) and **no global `statement_timeout`** (it would
    cut legitimate long statements; the gate's deadline covers the check). The gate is **single-flight with at most one outstanding check**: after a
    deadline the abandoned check stays in flight until it settles (the pool's `connectionTimeout` bounds it), no new check starts meanwhile, callers get the
    `database-unavailable` outcome, and a late settle updates the state only if it is still the newest. Tests in `schema-gate.spec.ts`: a check that never
    resolves yields `database-unavailable` at the deadline (fake timers), later calls do not start a second check, a late success after the deadline
    becomes `ok` on the next evaluation, a late failure does not overwrite a newer result.

3. **Setting `LAUNCHPAD_SCHEMA_CHECK_INTERVAL`** (controller only). Parsed by a new
   `parseSchemaCheckConfig(env)` next to the other config parsers in `packages/services` (new `controller-config.ts`, same
   style as `app-routing-config.ts`; the error text names the variable):
    - Unset or empty: default **10 s**. Uses the existing `parseDuration` (`10s`, `1m`) for consistency with
      `LAUNCHPAD_MAX_TTL`; bounds **1 s to 5 min**.
    - **`off`** (or `0`): the cached pass is never re-checked: exactly today's behavior (check once, repeat only a failure).
      Provided as the escape hatch if the extra queries are ever a problem. Documented as not recommended (the replaced-database
      case goes undetected until a restart).
    - Anything else (negative, zero with a unit, above 5 min, unparsable): startup fails with `LAUNCHPAD_SCHEMA_CHECK_INTERVAL must be a
      duration from 1s to 5m, or "off".`, validated in `startup-settings.ts` so the process stops at start rather than on a
      request. The retry after a failure (3 s) stays fixed and is not a setting.
    - Compose: `LAUNCHPAD_SCHEMA_CHECK_INTERVAL: ${LAUNCHPAD_SCHEMA_CHECK_INTERVAL:-}` and `LAUNCHPAD_SCHEMA_CHECK_TIMEOUT: ${LAUNCHPAD_SCHEMA_CHECK_TIMEOUT:-}` on the controller only; the example env
      (commented, empty means 10 s); `apps/controller/.env.local.example` and the README settings table;
      `tooling/compose-production.spec.ts` asserts it is passed to the controller and **not** to the worker.
4. **Mapping to responses.** A shared `databaseProblem(error): { status: 503; code; title } | null`:
   `schema-mismatch` (title "Service Unavailable", unchanged) or `database-unavailable` (title "The database is
   unavailable.", header `retry-after: 5`). Never the error message. Used in: `api.$.ts` (for rejections from the gate),
   `execute()` before the `internal` fallback, and a root Elysia `onError` hook that covers the paths outside `execute`;
   `onError` returns `undefined` for anything not classified, so other errors keep today's response. Contract:
   `errorSchema.code` (now built from an exported `ERROR_CODES` tuple) gains `"schema-mismatch"` and `"database-unavailable"`
   (`unavailable` already exists and is reused for the data-directory outcome); `openapi.ts` documents 503 once, shared.
5. **A database replaced by a migrated one** (same schema) is not detected, and the docs and code comment say so; restore stops
   the controller by the runbook.

### B. Liveness and readiness (#3, #5)

- **`GET /api/health` stays liveness and is routed around the gate for everything except a proven schema mismatch.** Verified in
  `routes/api.$.ts:10-21`: today _every_ `/api/**` request (health included) awaits `getReadyRuntime()` and **rethrows any error that is
  not a `SchemaMismatchError`**, so with the gate re-checking an unreachable database, `/api/health` would 500 and the Compose healthcheck
  (`r.ok`) would fail: this must be designed out. New handling in `api.$.ts`, before the generic path: for `GET`/`HEAD /api/health`
  call `gate.check()` **under a short deadline of 2 s** (fixed, not a setting: the Compose healthcheck is `timeout: 5s, interval: 15s, retries: 3`
  in `docker-compose.yaml`, so 2 s is well under it, leaving margin for the `bun -e fetch` startup) and branch on the outcome; **if the gate has not answered within the 2 s, `/api/health` serves the 200** (a hung check
  is exactly the outage case, and health must not depend on it); `schema-mismatch` still 503 only when the gate answered it: `schema-mismatch` -> 503 `schema-mismatch` (**today's behavior, kept unchanged for
  compatibility**); `ok`, `database-unavailable`, `unavailable` (data directory) and `failed` -> serve the 200 using `getRuntime()` (no database
  access; it only builds `getControllerInfo`). So liveness is 200 during any outage, a restart storm or `depends_on` deadlock cannot
  come from it, and the Compose healthcheck never fails on an outage (it fails only on a proven schema mismatch, as today). The new periodic
  check means that existing 503 can now appear without a restart (a replaced empty database): the same behavior reached sooner,
  documented as such. No change to the controller healthcheck (`/api/health`, 15 s). Unit-tested for each outcome and for a hanging gate (see tests); `tooling/compose-production.spec.ts` asserts the healthcheck `timeout` is greater than the 2 s health deadline.
  `/api/ready` uses the gate's 4 s deadline (a load balancer's own timeout applies on top).
- **`GET /api/ready` (new)** is readiness: uses the shared gate (cached; free when polled every 15 s), unauthenticated, and returns
  `200 { status: "ready" }` or `503 { code, status: 503, title }` with the code from the outcome table (`schema-mismatch`,
  `database-unavailable`, `unavailable`); an unclassified `failed` outcome is also `503 unavailable` with a fixed title, never a
  500 and never an error message (no secrets, versions, names or counts). It is a plain route in `api.ts` that `api.$.ts` also routes
  around the generic rethrow (it renders the outcome itself, like health). **Documented** in the OpenAPI document under Operations
  (load balancers are configured from it). Checks only the database and the data directory (what `getReadyRuntime` already
  requires), never Dokku, the router or the worker.
- **Which to use:** Docker/Compose healthcheck and process supervisors: `/api/health` (liveness). Load balancers, ingress
  and anything that decides "send traffic here": `/api/ready`. Documented in `docs/production-compose.md` (health section),
  `apps/controller/README.md`, `docs/install.md`. **No Compose healthcheck change** (justification above); the worker
  healthcheck is unchanged (#5: keep semantics; the docs get the rehearsal result for "recovery blocked", unhealthy after one to
  two minutes).
- `tooling/check-images.ts`/`tooling/experiments` poll `/api/health` today: unchanged.

### C. Worker identity and heartbeat (#1)

**Naming.** A worker has a stable **name**, the heartbeat's primary key. Resolution (`apps/worker/src/worker-id.ts`, renamed
helper `workerNameFromEnv`):

1. `LAUNCHPAD_WORKER_NAME` (same validation as today's id: 1 to 64 chars, `[A-Za-z0-9][A-Za-z0-9._-]*`);
2. else the existing `LAUNCHPAD_WORKER_ID` as a **deprecated alias** (same value rules) so existing installs that set it keep
   their name; logs a one-time `worker-name-deprecated` note;
3. else derived from the hostname (`os.hostname()` lowercased, characters outside the pattern replaced by `-`, truncated to 64,
   leading non-alphanumerics trimmed; if empty, `worker`).
   A **run id** (`randomUUID()`, per process) is new and recorded only in the heartbeat and logs. `lease_owner` keeps recording the
   **name** (as today when an id is set); fences are unchanged, so a stable name never lets a stale process write
   (`worker-id.ts` already states this). **Verified fencing** (`deployment-claims.ts:140-146` `fencedUpdate`, `deployment-deletion.ts:280-282`, `promotion-claims.ts:142-144`): every
   write made with a claim token (step begin/complete/stop, renew, hold, finalize) goes through a `where` on `lease_owner = token.owner` **and** `attempt = token.attempt`
   **and** `fence = token.fence`; every claim sets `attempt + 1` and `fence + 1` (`:94-96`, `:208-210`, `:102-104`). The other `lease_owner` sites only **clear** it
   (`lease_owner: null` in release/hold/reconcile paths, no read of the name). So a same-named restarted worker passes the owner comparison but fails attempt/fence for any
   work claimed by a newer run: the name is not the guard (as `worker-id.ts` says). Test below. Behavior change to state in the PR and release notes: with nothing set, `lease_owner` was a
   random uuid and is now the hostname-derived name.

- **Docker:** the default hostname is the container id, which changes whenever the container is _recreated_, so a recreated worker
  gets a new name, leaves **one stale row until pruned**, and status shows it as `stale` for a while (and the "no live worker"
  warning is not raised while another worker is live). **Compose sets `hostname: launchpad-worker` already**, so the default name
  is `launchpad-worker` across recreates; no extra setting is needed there. Outside Compose, and whenever two workers share a hostname or
  name, set `LAUNCHPAD_WORKER_NAME`. **Two live workers with the same name** share one row (last write wins); the heartbeat detects a
  different `run_id` that beat within the stale window and logs `worker-name-in-use` once, and the docs say to give each worker
  its own name.
- Compose: `LAUNCHPAD_WORKER_NAME: ${LAUNCHPAD_WORKER_NAME:-}` next to the existing `LAUNCHPAD_WORKER_ID` line;
  `docker-compose.env.example`: the name documented, `LAUNCHPAD_WORKER_ID` marked deprecated; `apps/worker/.env.local.example`;
  `docs/production-compose.md` (line ~414 "Worker identity"), `docs/install.md` (line ~52), `docs/access.md`/`local-quickstart.md`
  where `LAUNCHPAD_WORKER_ID` appears (grep at implementation; update each).

**Migration** `packages/database/src/migrations/<date>_002_worker_heartbeat.ts` (`<date>` sorts after `20261124_001`):

```
worker_heartbeat (
    name          text primary key,                      -- stable worker name
    run_id        uuid not null,                         -- this process's run; changes on every start
    started_at    timestamptz not null,                  -- when this run started (database clock); changes on every start
    seen_at       timestamptz not null,                  -- last beat (database clock), the only liveness signal
    stopped_at    timestamptz,                           -- set by a clean shutdown, cleared by the next start
    beat_seconds  integer not null check (beat_seconds between 5 and 60), -- this worker's configured beat, so the reader needs no matching setting
    check (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
)
index worker_heartbeat_seen_at_idx on (seen_at)          -- for the prune
```

- Additive, one new table and index, no change to any existing table, no data copy, cheap. Table type
  `WorkerHeartbeatTable` in `packages/database/src/index.ts`. No hostname, version, deployment ids or error text are stored.
- **Rollback story:** forward-only, as everything here. Rolling back the release means restoring the pre-upgrade backup
  (`docs/upgrade.md`). The **schema-rollback gate** makes an older controller refuse a migrated database (503
  `schema-mismatch`; `restore` refuses a post-migration backup on an older build), so nothing runs half-rolled-back. The upgrade
  notes list the migration. Restoring a pre-migration backup leaves the schema behind until `migrate` (the existing path).
- **Skew:** a new worker before `migrate`: the beat fails with `42P01`, is swallowed and logged once, the worker keeps claiming
  (the upgrade procedure stops all workers and the controller first anyway). An old worker beside a new controller never beats:
  status reports no worker and warns; recreate controller and worker together (already documented).
- After a restore the table carries the backup's old `seen_at`, so status says `stale` until the worker (started after the
  gates) beats again, correctly.

**Heartbeat** (`apps/worker/src/heartbeat.ts`, DB statements in `packages/services/src/heartbeat.ts`):

- A separate loop started from `index.ts` beside `workDeployments`, not inside the claim loop (a long run must not stop it; a
  wedged event loop or paused container should: W4). Only when deployments are on (with them off the worker never opens the
  database; status reports `off`).
- **Start:** `insert ... on conflict (name) do update set run_id = excluded.run_id, started_at = clock_timestamp(),
  seen_at = clock_timestamp(), stopped_at = null, beat_seconds = excluded.beat_seconds`. So a restart **updates the row in
  place**; rows do not multiply. **Beat:** `update ... set seen_at = clock_timestamp(), stopped_at = null where name = $1 and
  run_id = $2` (an update, not an upsert: if the row is missing or taken over by another run, re-insert once and log
  `worker-name-in-use`). **Clean stop:** `update set stopped_at = clock_timestamp() where name = $1 and run_id = $2`.
  **Shutdown ordering** (`apps/worker/src/index.ts` ~lines 76 to 93, today `try { await workDeployments(...) } finally { await db.destroy() }`):
  inside that `try`, after `workDeployments` returns **or throws** (put it in a `finally` that precedes `db.destroy()`), run
  `await heartbeat.stop()`, which (1) stops the beat loop and **awaits its in-flight beat to settle** (a late beat would clear
  `stopped_at`), then (2) writes the stop mark. The write has **its own 2 s timer** (`Promise.race` with a `setTimeout`/`AbortSignal.timeout(2000)`
  created at that moment), independent of the already-aborted `shutdown` signal and of the pool's 5 s statement timeout (the race
  ends the wait at 2 s; the abandoned statement is cut off by `db.destroy()`, whose `closeTimeout: 0` does not wait). Failure or
  timeout is swallowed and logged once. The whole stop costs at most 2 s, inside Compose's `stop_grace_period` (at least 30 s). Tests
  cover: stop after a normal return, after a thrown `workDeployments` (fault abort), with a store that hangs (returns at 2 s), and that no beat
  runs after the stop mark. **Prune:** at start, then once an hour, `delete where seen_at <
  clock_timestamp() - interval '<N> days'`, keeping decommissioned workers from lingering.
- **Single-flight:** the loop is one `while` that awaits each beat before sleeping (`beat; sleep(interval - elapsed)`, never `setInterval`), so beats never overlap. Each beat has a hard deadline of **5 s**, which is below the smallest allowed interval (5 s: the bound is `beat deadline <= interval`, and the deadline is `min(5 s, interval)`) so a slow beat finishes or is abandoned before the next starts; an abandoned statement is not retried on top of itself. Tests: a beat that outlasts its deadline is followed by exactly one next beat, never two in flight.
- Never throws, never aborts the worker, never calls `markHealthy()` (the health file keeps its meaning). A DB error is logged once
  per outage with a fixed message (no error text), like `deployment-worker-error`. Deadline 5 s, same pool (`max: 2`); the
  heartbeat holds a connection for one statement, and a test checks it cannot starve the 8 s `database()` deadlines.
- **Cost:** at the default 15 s, 5,760 single-row HOT updates a day per worker on a table of a handful of rows; the status
  read is on demand. Beat load is independent of the number of deployments.

**Derived state** (decision 7). The worker writes facts (`seen_at`, `started_at`, `stopped_at`, `run_id`); the reader derives the state
at read time from the database clock:

| Derived state | Rule (SQL, `clock_timestamp()` as `now`)                                               | Meaning                                     |
| ------------- | -------------------------------------------------------------------------------------- | ------------------------------------------- |
| `ok`          | `now - seen_at <= S` and `stopped_at is null`, with `S = max(stale, 3 * beat_seconds)` | beating                                     |
| `stopped`     | `stopped_at is not null` (set by a clean shutdown; the next start clears it)           | stopped on purpose (`docker stop`, SIGTERM) |
| `stale`       | `now - seen_at > S` and `stopped_at is null`                                           | **crash, kill, pause or lost database**     |

`stale` detection uses `seen_at` only, independent of `stopped_at`: a worker that stops beating without clearing is stale
whether or not a stop mark exists. **A stale row with no `stopped_at` means crash, `docker kill`, pause, OOM or an unreachable
database; the docs say so, and that `docker stop` (SIGTERM) normally leaves `stopped` and `docker kill` leaves `stale`.** A stop
mark older than the stale window still reads `stopped`, but a row whose `stopped_at` is _older than_ `seen_at` cannot occur
(the start clears it). **Recommendation: no stored state enum.** A state the worker writes is wrong in exactly the cases that
matter (it cannot write "crashed" when it crashes; an enum would need the reader to second-guess it with `seen_at` anyway),
needs a state machine and CHECK constraints, and cannot express thresholds that are configurable and may change. Columns
plus derivation have no impossible states and no migration when thresholds or labels change. An optional `stopped_reason`
is not added (YAGNI).

**Thresholds (all configurable, one parser `parseHeartbeatConfig(env)` in `packages/services`; durations use `parseDuration`):**

| Setting (env)                         | Default | Bounds        | Read by            | Relations enforced at startup                                                 |
| ------------------------------------- | ------- | ------------- | ------------------ | ----------------------------------------------------------------------------- |
| `LAUNCHPAD_WORKER_HEARTBEAT_INTERVAL` | 15 s    | 5 s to 60 s   | worker             | `beat * 3 <= stale` (worker checks against its own configured stale)          |
| `LAUNCHPAD_WORKER_STALE_AFTER`        | 60 s    | 15 s to 240 s | controller, worker | `stale <= lease - 60 s = 240 s`; `stale >= 3 * beat`                          |
| `LAUNCHPAD_LEASE_WARN_BEFORE`         | 90 s    | 30 s to 240 s | controller         | `warn <= lease - 60 s = 240 s` (lease = `DEPLOYMENT_LEASE_MS` = 300 s)        |
| `LAUNCHPAD_WORKER_PRUNE_AFTER`        | 7 d     | 1 h to 90 d   | worker             | none needed: the minimum (3,600 s) exceeds the largest possible stale (240 s) |

**The arithmetic** (lease `L = 300 s`; a live worker renews every 2 s, so `lease_expires_at` is about the last renewal + `L`; `t0` is the last beat of a worker that has died):

| Quantity                                | Formula                                | Default | Min possible | Max possible            | Always valid because                                                                                                                |
| --------------------------------------- | -------------------------------------- | ------- | ------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Stale limit used by the controller      | `S = max(stale, 3 * row.beat_seconds)` | 60 s    | 15 s         | `max(240, 180) = 240 s` | `beat <= 60` so `3 * beat <= 180 <= 240`; `S <= L - 60`                                                                             |
| "No worker" warning fires at            | `t0 + S`                               | 60 s    | 15 s         | 240 s                   | `S <= 240`, so always **at least 60 s before the lease can expire**                                                                 |
| Lease warning (no live worker) fires at | `max(t0 + S, t0 + L - warn)`           | 210 s   | 60 s         | 270 s                   | `warn >= 30` and `<= 240` give `L - warn` in `[60, 270]`; `S <= 240` gives a fire time of at most 270 s, **before expiry at 300 s** |
| Beats missed before "stale"             | `S / beat`                             | 4       | 3            | not bounded             | `S >= 3 * beat` by construction                                                                                                     |

(The lease warning does **not** need `warn >= stale`: it fires at `max(S, L - warn)`, which is
`<= 270 s < L` for every allowed pair, so it always precedes expiry; the "no worker" warning is the early one, the lease warning is the one
that says work is at risk.) `beat_seconds` in the table has `check (beat_seconds between 5 and 60)`, the same bounds as the setting, so a row can never
claim a beat the setting would have refused; the controller does not trust it beyond that range. **Accepted limitation:** the CHECK hard-codes 5 to 60 in the schema; widening the setting's bounds later needs a forward migration to replace the constraint (the setting's own bounds can be narrowed without one). If `beat_seconds` is outside
(a hand-edited row) the controller clamps to `[5, 60]`.

- Durations: `15s`, `1m`, `7d`. Out of range, unparsable or violating a relation fails startup naming the variable and the relation
  (`LAUNCHPAD_WORKER_STALE_AFTER must be at least 3 times LAUNCHPAD_WORKER_HEARTBEAT_INTERVAL (45s)`). The **worker** validates beat, stale and
  prune; the **controller** validates stale and warn; a setting a process does not read is not required there. The controller applies
  `S = max(stale, 3 * row.beat_seconds)` so a controller left at the default stale never mislabels a worker that runs a slower beat. The two heartbeat
  settings the controller also reads go through the shared settings anchor so both containers see the same values;
  `tooling/compose-production.spec.ts` asserts that.
- The existing 300 s lease and its 10 s margin are untouched (not configurable); if `DEPLOYMENT_LEASE_MS` ever changes, the bounds are derived from
  the constant (`lease - 60 s`), not hard-coded, and the boundary tests recompute them.

### D. Status (`GET /api/v1/status`, additive)

`statusSchema` (strict) gains:

```
workers: {
  state: "off" | "ok" | "stale" | "missing",
  items: [{ name, state: "ok" | "stale" | "stopped", lastSeenSecondsAgo, runStartedAt }]   // newest first, at most 20
},
leases: { inFlight, expiring, expired }                                                      // counts only
```

- `workers.state`: `off` when the controller's deployments are off; else `ok` if at least one item is `ok`, `stale` if rows exist
  and none is `ok`, `missing` if there are no rows. `name` is operator-chosen or hostname-derived (not remote text); `runStartedAt` is
  the row's `started_at`. No run id, hostname or version is exposed.
- `leases` count in-flight deployment (`preparing`/`building`/`deploying`/`verifying`), deletion (`running`) and promotion operations
  holding a lease: `expired` = `lease_expires_at <= now`; `expiring` = within `LEASE_WARN_BEFORE`. SQL on the database clock; terminal
  rows are excluded.
- **Warnings** (fixed templates, counts and durations only, no ids), the existing `warnings` array:
    1. deployments on and `workers.state` is `stale` or `missing`: "No deployment worker has reported for N seconds (or ever)." (always,
       even with nothing in flight: answers #1);
    2. leases expiring or expired and no live worker: "N deployment operation(s) hold a lease that is about to expire or has expired, and no
       worker is running; they are held for reconciliation when a worker starts.";
    3. leases expired for more than 60 s while a worker reports in (wedged worker): "N operation(s) are past their lease while a worker reports in."
       The earliest warning for a killed worker is the "no worker" one, about one stale window (60 s by default, at most 240 s) after the last beat:
       **at least 60 s and by default four minutes before the lease can expire**; the lease warning follows at 210 s by default (see the arithmetic table).
- `getStatus` takes `{ deploymentsEnabled, thresholds }` from the controller; still operator-only. **No defensive missing-table branch**: the
  request path is behind the gate, which answers 503 `schema-mismatch` until `migrate` has run, and a table dropped mid-window raises `42P01`, which
  A.4 maps to the same 503 and invalidates the gate; a branch in `getStatus` would be unreachable and untested code. `openapi.ts` `getStatus` text no longer says "emits no warnings".

### E. Dashboard (decision 6)

Goal: a database problem during a page load, a server function call or an SSR render shows a clear, non-technical error state with a
retry, never a raw 500 or "Organization not found", with the right status code, and with no error text or addresses shown.

- **Server side:** `apps/controller/src/server/data.ts` and `session.ts` wrap every handler body in one helper
  `withDatabaseProblems(fn)` (new `apps/controller/src/server/database-problem.ts`) that calls the same `databaseProblem` mapper
  (section A.4) and, for a classified error, throws a typed, serializable `ServiceUnavailable` problem
  (`{ code: "database-unavailable" | "schema-mismatch" }`, no message); anything else is rethrown unchanged. `principal()` and
  `getFeaturesFn` (which call `getReadyRuntime()` first and so throw the `SchemaMismatchError`) are covered by the same wrapper.
  **How the problem crosses the server-function boundary (and whether SSR can return 503) is Unknowns 2**: the spike picks the
  mechanism TanStack Start 1.x supports for a typed error from a server function (a thrown `Response`/custom serializable error, or a
  returned discriminated union), then everything below follows it. The fallback, if only returned values are supported, is
  `{ problem: { code } }` handled in the loaders; costlier, so avoided if a thrown error works.
- **UI:** a new `apps/controller/src/components/service-unavailable.tsx` (semantic, `role="alert"`, matching the existing pages'
  markup and classes) with titles and text per code: `database-unavailable` ("Launchpad can't reach its database right now. Try again in a
  moment.") and `schema-mismatch` ("Launchpad's database needs attention. The instance operator needs to run the upgrade or restore
  procedure."), a **Retry** button (`router.invalidate()`), and no raw message. A pure helper
  `describeProblem(error): { code, title, text } | null` decides, so it is testable without a DOM.
  Wiring: `router.tsx` `defaultErrorComponent` and `__root.tsx` `errorComponent` render it for classified problems and a generic
  "Something went wrong" (also no raw text) otherwise; `orgs.$orgId.tsx`'s `errorComponent` shows "Organization not found." only for
  a real not-found and delegates other problems to the shared component (today it mislabels everything). The login page needs the database to sign in, so it shows the same state.
- **Actions** (`apiRequest`/`apiCall` in `lib/api.ts`): already display `problem.title`; with A.4 the title is "The database is
  unavailable." with 503. Add `code`-aware text (one line: for `database-unavailable` show "Launchpad can't reach its database. Try
  again in a moment.") so it matches the page state.
- **Status codes:** if SSR/server-function responses can carry a status, return 503 with `retry-after: 5` for classified problems; if
  the framework cannot, the page renders the state with a 200 and the PR says so (the API and `/api/ready` carry the 503s).
- No dashboard feature otherwise changes; no new server functions.

## Slices, commits and the review gate (one PR)

Each slice is one commit (when asked to commit), compiles, and passes `omni run check test` for what it touches. Order by risk: error handling lands before the periodic check that can trigger it, no schema until slice 4.

1. **Spikes and shared plumbing, no behavior change.** Unknowns 1 to 3 resolved and recorded in the PR; `packages/database/src/errors.ts`
   (+ spec); `createSchemaGate` with the staged outcomes extracted from `runtime.ts` (+ spec), with today's semantics (a pass is final).
2. **Error mapping and readiness, before any periodic check.** `databaseProblem`, `execute()` and root `onError`, `api.$.ts` (including the
   health bypass and `/api/ready`), contracts codes (`ERROR_CODES`), OpenAPI; unit and API tests. After this commit a failing check already maps
   to clear 503s (and the data-directory outcome no longer 500s), so enabling the re-check cannot surface raw errors.
3. **Settings and the periodic check.** `parseSchemaCheckConfig`, `LAUNCHPAD_SCHEMA_CHECK_INTERVAL` wired in `startup-settings.ts`, the gate
   interval on (default 10 s); compose, env examples, README, `compose-production.spec.ts`; hop tests for the replaced-database case.
4. **Migration and worker identity.** The migration file and table type alone with its migration tests (a reviewer can read this commit
   first); `workerNameFromEnv`, heartbeat module, `LAUNCHPAD_WORKER_NAME` and the heartbeat settings (`parseHeartbeatConfig`), compose and
   env examples, worker wiring and tests.
5. **Status.** `getStatus`, contracts, OpenAPI text, warnings, tests.
6. **Dashboard.** `database-problem.ts`, `service-unavailable.tsx`, route and router error components, `lib/api.ts` text, tests.
7. **Docs.** `docs/production-compose.md`, `docs/restore.md`, `docs/upgrade.md`, `docs/install.md`, `docs/patterns/README.md`,
   `apps/controller/README.md`, `docs/plans/rehearsal-defects-fixes.md` status line, `docs/plans/production-rehearsals-db-worker-restore.md`
   (mark #1, #3, #5, #8 resolved with the PR number once merged; the evidence README is a snapshot and is not edited).

**Review gate (independent, required at high risk).** After slice 4 and again after slice 6 (before opening the PR) an independent
reviewer, not the author, reviews: the migration and its rollback story, the gate (can a bug turn the whole API into 503?), the heartbeat's
failure containment, and the public contract changes. Findings are applied before the next slice. Full set of checks runs once at
integration (below), then self-review (`swe-self-review`), then the PR description (`swe-change-description`), which names the migration,
the new codes/endpoint/settings, and the lease_owner default change.

## Files (summary)

| Area       | Files                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| database   | `packages/database/src/errors.ts` (+ spec), `src/index.ts`, `src/migrations/<date>_002_worker_heartbeat.ts`                                                                                                                                                                                                                                                               |
| contracts  | `packages/contracts/src/index.ts` (`errorSchema` codes, `statusSchema`)                                                                                                                                                                                                                                                                                                   |
| services   | `src/controller-config.ts` (schema-check and heartbeat settings, + spec), `src/heartbeat.ts`, `src/status.ts`, `src/__tests__/{status,heartbeat}.spec.ts`                                                                                                                                                                                                                 |
| controller | `src/server/runtime.ts` (gate), `src/server/schema-gate.ts` (+ spec), `src/server/api.ts`, `src/server/openapi.ts`, `src/routes/api.$.ts`, `src/server/startup-settings.ts`, `src/server/{data,session}.ts`, `src/server/database-problem.ts`, `src/components/service-unavailable.tsx`, `src/router.tsx`, `src/routes/{__root,orgs.$orgId}.tsx`, `src/lib/api.ts`, tests |
| worker     | `src/worker-id.ts` (+ spec: name resolution), `src/heartbeat.ts` (+ spec), `src/index.ts`                                                                                                                                                                                                                                                                                 |
| deployment | `docker-compose.yaml`, `docker-compose.env.example`, `apps/{controller,worker}/.env.local.example`, `tooling/compose-production.spec.ts`                                                                                                                                                                                                                                  |
| docs       | `docs/production-compose.md`, `docs/restore.md`, `docs/upgrade.md`, `docs/install.md`, `docs/access.md`, `docs/local-quickstart.md` (worker name mentions), `docs/releasing.md` (upgrade note), `docs/patterns/README.md`, `apps/controller/README.md`, the plan files above. `docs/tooling.md` only if `check:compose` changes.                                          |

## Docs content

- **#8:** `docs/restore.md`, in the refusal section: the manifest records size and SHA-256 of the dump, and `verify-backup`/`restore` check
  them; `pg_restore --list` does not read data blocks, so some single-byte corruptions pass it and only the manifest checksum catches
  them; the manifest is not itself signed, so a forged manifest defeats the check; a failure mid-import is rolled back (V8/V9). Keep
  backups on storage you trust and the printed checksum with them.
- **#5:** `docs/production-compose.md`: the worker healthcheck proves liveness and database access only; `unhealthy` after one to two
  minutes in a database outage or while recovery blocks claims (rehearsal V8/D1a); nothing restarts an unhealthy container. Unchanged.
- **#1:** `docs/production-compose.md` "Stopping and restarting the worker": replace "Nothing in the API says the worker is dead" with
  the status fields, the three warnings, the thresholds and their settings, the `ok`/`stale`/`stopped` meaning (stale with no stop mark
  means crash, kill, pause or lost database), the identity rules (name, Docker hostname, one stale row until pruned, one name per
  worker). Keep: `restart: unless-stopped` does not restart `docker stop`/`docker kill`ed containers (Docker treats them as manual
  stops) but does restart a crash exit; start it and then `deployment-reconcile` held work.
- **#3:** the 10 s window and the setting; `schema-mismatch` and `database-unavailable`; liveness vs readiness table; the
  `/api/health` compatibility statement; what is not detected (a replaced database with the same schema).
- `docs/upgrade.md`: this release adds a migration, recreate controller and worker together, rollback is a backup restore.

## Test plan

**Error-code drift guard** (`packages/contracts` exports `ERROR_CODES` as a `const` tuple and `errorSchema` uses `z.enum(ERROR_CODES)`; the new
codes `schema-mismatch`, `database-unavailable` are added once there). How the test enumerates emitted codes: (1) a spec in `apps/controller/src/server/`
reads the source of `api.ts`, `routes/api.$.ts`, `runtime.ts` and the new `database-problem.ts` and extracts every string literal following `code:`
and every key of the `STATUS` map with a regex, and asserts each is in `ERROR_CODES` (this catches a new literal that nobody added to the enum, such as the
existing `schema-mismatch` drift); (2) behavioral cases for the outcome table, `/api/ready` and the health bypass parse each 4xx/5xx body with
`errorSchema.parse` (the pattern `hop.spec.ts` already uses). The static scan is a guard, not a proof; the behavioral parses are what pins the shapes.
**Verified clients:** `errorSchema` is imported only by `packages/services/src/contracts.ts` (a re-export), `apps/controller/src/server/openapi.ts`
(documentation of responses, no runtime validation), `packages/contracts/src/contracts.spec.ts` and first-party tests (`hop.spec.ts`,
`deployments-api.spec.ts`). The SDK (`packages/sdk/src/transport.ts` ~254) reads `code`/`title` by hand and tolerates unknown codes; the CLI, MCP and
`client-core` do not import it. So no shipped client rejects the new codes; `openapi.ts`'s shared 503 text (`ERRORS[503]`, "Deployments or aliases are
turned off...") is updated to also say "or the database or data directory is unavailable".

Unit (no infrastructure, `omni run test`):

- `errors.spec.ts`: classifier table from the spike's real shapes plus `Error("boom")` and non-Errors.
- `schema-gate.spec.ts` (fake clock): **hanging check** (a `check` that never settles gives `database-unavailable` at `LAUNCHPAD_SCHEMA_CHECK_TIMEOUT`, no second check is started while it is outstanding, a late settle is applied only if newest); stage 2 runs on the first check and for readiness but not on periodic traffic re-checks; pass cached for the interval and rechecked after; failure retried after 3 s; single flight;
  `invalidate`; interval `off` means a pass is final; the failure code distinguishes `schema-mismatch` from `database-unavailable`.
- `controller-config.spec.ts`: `LAUNCHPAD_SCHEMA_CHECK_TIMEOUT` default 4 s, bounds 1 s and 30 s (0 s and 31 s refused), and the relation with the interval (timeout < interval, boundary at equal and one step either side, ignored when the interval is `off`); each setting's default, bounds, `off`/`0`, units, unparsable values, with the error text; and **boundary tests for every
  relation and bound in the arithmetic table, each at the limit and one step either side**: beat 4 s (refused), 5 s, 60 s, 61 s (refused); stale 14 s (refused), 15 s,
  240 s, 241 s (refused); `beat * 3 <= stale` at `beat 20, stale 60` (ok), `beat 21, stale 60` (refused), `beat 5, stale 15` (ok), `beat 60, stale 180` (ok),
  `beat 60, stale 179` (refused), `beat 60, stale 240` (ok); warn 29 s (refused), 30 s, 240 s, 241 s (refused); prune 59 min (refused), 1 h, 90 d, 91 d (refused);
  the derived limits recomputed from `DEPLOYMENT_LEASE_MS` (`lease - 60 s`) so a lease change moves the bounds; the effective stale `max(stale, 3 * beat_seconds)` for
  `beat_seconds` 5 and 60 with stale 15 and 240 (equal to 15, 180, 240 as per the table), a hand-edited out-of-range `beat_seconds` clamped; the lease-warning fire time
  `max(S, L - warn)` over the corner pairs (S 15 or 240, warn 30 or 240) never reaches `L`.
- `deployment-claims`, `deployment-deletion`, `promotion-claims` DB tests (extend the existing fencing specs): run A (name `w`) claims and holds a token; the
  lease is allowed to expire; run B (same name `w`, new run) claims (attempt and fence advance); every token-based write by A (begin, complete, stop, renew,
  and the promotion finalize/hold) updates **zero rows** and surfaces as lost authority, even though `lease_owner` equals A's name; B's writes succeed.
- `worker-id.spec.ts` (name): precedence `NAME` > `ID` > hostname; hostname sanitizing (case, dots, long, empty, leading symbols);
  invalid values refused; the deprecation note once.
- `api.spec.ts` (fake db/auth that throw): key lookup, session lookup, `throttleSignIn` throwing `unreachable` give 503
  `database-unavailable` with `retry-after` and no message text; `42P01` gives `schema-mismatch`; an unclassified error is still 500 `internal`;
  `ServiceError`/`DeploymentRecoveryError` unchanged; `/api/ready` 200/503 shapes and no secrets for each outcome including `unavailable` (data directory) and an unclassified failure (503, never 500); `/api/health`: **with a gate that never answers it still returns 200 within 2 s (fake timers), and `/api/ready` returns 503 `database-unavailable` at the gate deadline**;
  200 for `database-unavailable`, `unavailable` and `failed` outcomes, **503 `schema-mismatch`** for that outcome (unchanged), never a 500 (this is the
  regression test for `api.$.ts` rethrowing); other routes: the mapped 503 for each outcome and the unclassified one stays 500; the error-code drift guard (below).
- `heartbeat.spec.ts` (fake store and clock): the shutdown ordering (stop after return, after a thrown `workDeployments`, a hanging store ends at 2 s, no beat after the stop mark, the 2 s timer is independent of an already-aborted signal); first beat inserts and prunes, beats at the interval, a failing store never throws or stops
  the loop and logs once per outage, a lost row re-inserts and logs `worker-name-in-use`, the clean stop writes `stopped_at` within its
  deadline and tolerates failure, abort with the signal, nothing runs with deployments off, the health marker is not touched.
- `describeProblem` and `database-problem.ts` (pure): classification to title/text, never includes the error message.
- `compose-production.spec.ts`: new variables passed to the right service only; no change to either healthcheck.

DB integration (`omni -i run test:db:up`; `test:integration -p @launchpad-kit/{services,controller,worker,database}`; `test:db:down`):

- Migration: applies on an empty database, and on a database at `001` with rows (rows untouched); `migrate --status` pending then applied
  (`apps/controller/src/admin/__tests__/upgrade.spec.ts` extended); the name CHECK and `beat_seconds` CHECK reject bad values; the schema
  gate refuses a build that does not know it (the rollback gate), using the existing folder fixture mechanism in `testing.ts`.
- Gate against a real database: migrate (pass), `drop schema public cascade` (D1c fault), after the interval the gate fails with
  `schema-mismatch`; migrate again recovers; `42P01` mid-window invalidates.
- `heartbeat` store: a start upserts in place for the same name (one row after two starts, `run_id`/`started_at` change, `stopped_at`
  cleared); a beat updates only its own run; two names give two rows; the clean stop sets `stopped_at`; the prune removes only rows older than
  the age.
- `status.spec.ts` (extended): `off`/`missing`/`ok`/`stale`/`stopped` over seeded rows and thresholds (use SQL timestamps); the per-row
  `beat_seconds` raises the effective stale limit; lease counts for deployments, deletions and promotions, terminal rows excluded; each of the three
  warnings and none when healthy; no identifiers in any warning (uuid-pattern assertion); non-operator `forbidden`.
- Worker: with both loops running, an injected heartbeat failure does not abort `workDeployments` and does not stop `markHealthy`, and the 8 s
  deadlines are not starved (`deployment-worker.spec.ts` style).
- `hop.spec.ts` (built server over HTTP, near the existing 503 test ~1360): drop `public` under a running controller, `/api/v1/me` and `/api/ready`
  turn 503 `schema-mismatch` within the interval **without a restart**, `/api/health` shows 503 `schema-mismatch` as documented, recovery after
  `migrate`; with the database connections terminated (or an unreachable `DATABASE_URL` after start, if the harness cannot stop Postgres)
  `/api/ready` and API calls answer `database-unavailable` while `/api/health` stays 200; a dashboard page request while unavailable returns the
  unavailable state (the SSR HTML contains the title text and no raw error text), and the server function endpoint answers the classified problem;
  `/api/v1/status` as the operator returns the new fields (`workers.state: "off"` with deployments off).
- No component test infrastructure exists; the UI is covered by the pure helper test and the SSR assertions above. Adding jsdom/testing-library is
  **not** part of this PR.

Manual, by the user on a disposable `local:deploy` stack (this plan starts no servers): kill the worker mid-deployment and read status within about 60 s;
`docker start` and watch it clear within one beat; recreate the worker container and see one `stopped`/`stale` row age out; replace Postgres with an empty
one (D1d) and see 503 and the dashboard state within the interval; stop Postgres and see `/api/ready` 503 while `/api/health` stays 200.

Checks (once at integration): `omni run check test build` for `@launchpad-kit/{database,contracts,services,controller,worker}` and the tooling
project (`check:compose`), then the DB integration set above.

## Risks

- **A hung database must not hang liveness or the gate:** hard gate deadline (4 s), a 2 s health deadline answering 200, `connectionTimeout: 5` on the controller pool, at most one outstanding check.
- **New behavior to list in the PR and release notes:** (1) a failing periodic re-check now rejects traffic with 503 until it passes (previously a pass was final); (2) `/api/ready`, new codes, new settings; (3) `lease_owner` default; (4) the controller pool gets `connectionTimeout: 5`.

- **The re-check can make `/api/health` fail an outage** if the bypass is wrong (`api.$.ts` rethrows non-mismatch errors today): designed out in section B and
  covered by the regression tests; the slice order puts the mapping before the re-check.
- **Data-directory failures** were a raw 500 inside the gate; now an explicit `unavailable` outcome (503), and `/api/ready` can never 500.

- **The gate takes the API down.** A bug in the shared gate affects every route and readiness. Mitigation: one small pure unit with a fake clock,
  single flight, a pass is never turned into a failure except by a real query result, only classified errors map to 503, `off` restores today's behavior,
  review gate.
- **Migration is hard to undo** (restore only). Mitigation: one additive table, its own commit and review, rehearsal by the user, skew cases tested.
- **False classification** hides a bug as 503 or shows 500 for an outage. Mitigation: conservative classifier from real error shapes; unknown stays 500.
- **Global `onError`** could change other responses; it returns `undefined` for anything else; covered by tests.
- **`lease_owner` default changes** from a random uuid to the hostname-derived name; safe because claims are fenced by attempt and fence (not the name),
  but visible in logs and the database; stated in the PR and notes. **Two workers with one name** share a row (detected and logged).
- **Heartbeat in the pool** (`max: 2`): bounded to 5 s and one statement; tested against starvation. A heartbeat failure never affects health or claims.
- **Dashboard rework size** depends on how TanStack Start carries a typed error (Unknowns 2); fallback is to cut slices 4 to 6 out.
- **Settings sprawl and mismatch** (six new variables): defaults need no configuration; the controller uses the row's `beat_seconds`; compose passes
  the shared ones through the shared anchor; each is validated at startup with a message naming the variable and relation.
- `/api/health` still turns 503 for a proven schema mismatch (kept for compatibility); a restart policy never acts on it in Compose, and an
  external supervisor that restarts on it would restart a controller that cannot fix the database: the docs say to use `/api/ready` for traffic and
  `/api/health` for process liveness and to alert, not restart, on the 503.
- A clean `docker stop` reads `stopped`, so an operator who stops the worker deliberately gets no "worker down" warning for `stopped` only if other
  workers are live; with no live worker the "no worker has reported" warning is still raised (deliberate: the instance cannot deploy).

## Unknowns to settle in slice 1 (bounded spikes)

1. Real Bun SQL error shapes (`code`, `errno`, class name) for connection refused/closed, timeout and `42P01`: from a unit test that connects
   `createDatabase` to a closed loopback port and one that reads a missing table on the disposable test Postgres. If no stable property exists, the
   classifier falls back to SQLSTATE `code` then constructor name and the "unreachable" list shrinks to what is proven.
2. How TanStack Start (the version pinned in the catalog) transports a typed error or a status from a `createServerFn` handler to the client and
   during SSR: thrown `Response`/custom error versus a returned union; whether the SSR response status can be set. Decides slice 6's mechanism.
3. Elysia `onError` ordering relative to the existing handlers and `openApiPlugin`; where `/api/ready` and `/api/health` must sit relative to the gate in
   `api.$.ts`.

## Decisions still needed

The three open questions of the previous revision are taken as recommended unless told otherwise (`LAUNCHPAD_WORKER_ID` kept as a deprecated alias; `lease_owner`
records the name, now **verified safe** by the fencing audit above; setting names and `15s`/`1m` syntax as listed). **New, from the review (each with a recommendation):**

1. **A failing re-check of an expired pass fails closed** (503 for non-health routes until a check passes, at most 3 s per retry), recommended, versus serving on the old
   pass when the failure is only `database-unavailable` (smaller blip, but a gate that can serve while unverified).
2. **Data directory failure code:** reuse `unavailable` (recommended, already in `errorSchema.code`, no new code) or add a dedicated `data-unavailable`.
3. **Bounds** in the arithmetic table (beat 5 s to 60 s, stale 15 s to 240 s, warn 30 s to 240 s, prune 1 h to 90 d): confirm.
4. **Stage 2 (data directory) scope:** first check and `/api/ready` only, not the periodic traffic gate (recommended), or gate all traffic on it every interval.
5. **`LAUNCHPAD_SCHEMA_CHECK_TIMEOUT`** default 4 s (1 s to 30 s) and the fixed 2 s health deadline, plus `connectionTimeout: 5` on the controller pool: confirm.

## Implementation notes

Spike findings (run against PostgreSQL 17 and the built server; nothing left running):

1. **Bun SQL error shapes.** Every error is a `PostgresError`. Driver-side failures carry only `code`:
   `ERR_POSTGRES_CONNECTION_REFUSED` (closed port and unresolvable host) and `ERR_POSTGRES_CONNECTION_TIMEOUT`
   (blackholed address with `connectionTimeout`). Errors the server sent carry `code: "ERR_POSTGRES_SERVER_ERROR"`
   (or a specific label such as `ERR_POSTGRES_SYNTAX_ERROR`) and the **SQLSTATE in `errno`**, not in `code`:
   `42P01`, `42703`, `57P01` (terminated by an administrator, and in flight when the server stopped), `57P03`
   (server shutting down), `57014` (statement timeout), `28P01`, `3D000`. `ERR_POSTGRES_CONNECTION_CLOSED` was not
   produced by any fault tried and is not classified. A pool whose backend was terminated reconnects on the next
   query. `allow_connections false` answers `55000`, which is not classified (it is not specific to an outage);
   the hop test uses a TCP forwarder that is taken away instead.
2. **TanStack Start (start-server-core 1.169, start-client-core 1.170).** A server function error crosses as the
   serialized error with **only its message** (`$TSR/Error`): custom classes, `code` and `status` fields are lost,
   and unclassified messages (`Failed to connect`, Zod details) reach the browser. `setResponseStatus` and
   `setResponseHeader` do work: the SSR page and the server function endpoint answer `503` with `Retry-After`, and
   SSR renders the `defaultErrorComponent`. So the mechanism is a fixed code in the error message
   (`launchpad:<code>`, `apps/controller/src/lib/problem.ts`), set by `withDatabaseProblems` on the server and read
   by `describeProblem` in the error components. Dashboard status codes are therefore real 503s, not 200s.
3. **Elysia.** A root `.onError` registered before the routes also receives errors thrown from `onRequest` hooks
   (sign-in throttling); returning `undefined` leaves the framework's own 500. Elysia's 500 for an unclassified
   error outside `execute` is its own body, not the contract's `internal`.

Deviations from the plan:

- **No index on `worker_heartbeat(seen_at)`.** The plan's index would make every beat a non-HOT update (the column
  is updated each beat) for no benefit on a table of a handful of rows pruned at least daily.
- **Heartbeat store method `cleanup`** (not `prune`) in the worker: a source scan in `lifecycle-ports.spec.ts` forbids the word anywhere in worker sources.
- **`getReadyRuntime` rejects with `GateRejectedError`** (carrying the outcome) instead of the original error, so
  the server functions and the API map one outcome table.
- **The gate has no "newest result" sequence guard**: with at most one outstanding check no newer result can exist, so a late settle simply updates the state.
- **`@launchpad-kit/database` gained unit and integration test tasks** (it had none) for the classifier and the
  migration tests.
- The `statusSchema` `inFlight` counts every non-terminal operation holding a lease, expired ones included.
- Dashboard not-found: a missing or forbidden organization maps to a fixed `not-found` code so
  "Organization not found." stays exactly for that case; its HTTP status is unchanged (not set to 404).
