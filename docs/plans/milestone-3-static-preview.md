# Milestone 3: one static artifact reaches a working preview

Status: **approved by the user (2026-11-15)**; built slice by slice. High risk.
Extends `docs/plans/application.md` milestone 3 and `docs/design/application.md`
("Static deployment path", "Jobs, concurrency and reconciliation").

## Assessment

- **Kind:** large (new tables, a new privileged process, uploads, external side
  effects). **Risk:** High: persistent data, a privilege boundary (Docker and SSH
  to Dokku), concurrency, uploads of untrusted archives, and external side
  effects that are not transactional with PostgreSQL.
- **Unknowns that decide the shape:** whether pg-boss attempts can be fenced
  (milestone 0 says they must be added by us); how a streamed upload crosses the
  Start hop; how to build the fixed Nginx image from the worker without a
  user-controlled Dockerfile; how to detect an uncertain SSH outcome; SPA fallback
  and proxy readiness (both untested so far).
- **Undo:** per slice. No Dokku-mutating path is reachable until slice 5, and it
  ships disabled (`LAUNCHPAD_DEPLOYMENTS=off` by default). Rolling back is
  disabling that flag and reverting; migrations are forward-only, so tables stay
  and are simply unused.
- **Execution:** solo, one PR per slice, independent Opus review of the safety
  gate (slices 4–5) and of the milestone. No parallel agents: contracts and the
  state machine are shared.

## Outcome

A deployer creates a preview and uploads a built static site (a bounded archive)
from the CLI or dashboard; it is validated, stored, built into a unique image from
Launchpad's fixed template, streamed to Dokku, deployed under a generated app
name, probed through the proxy, and only then marked active. Status and progress
are persisted and visible by polling. A failed replacement leaves the previous
preview serving.

## Worked example the milestone must handle (also the integration fixture)

- **Happy path:** a fixture site (`index.html`, `app.js`, `assets/logo.svg`) is
  uploaded for `acme/website` preview `review`; the deployment goes
  queued → preparing → building → deploying → verifying → succeeded; `GET /`
  returns the fixture, and an unknown path is a real 404.
- **SPA:** with `spa: true` a deep link `/dashboard/settings` returns `index.html`
  with 200; without it, 404.
- **Complexities:** two deployments to one preview at once serialize (the second
  waits or is rejected, never overlaps); a worker dies mid-deploy and a second
  worker takes over after lease expiry while the first is still running (the stale
  one must not mutate); SSH times out after the remote change succeeded
  (`reconciliation-needed`, no blind retry); the database is unavailable during a
  deploy.
- **Edge cases:** archive with `../x`, absolute path, symlink, hardlink, device,
  duplicate path, `.env`, `.git/`, no `index.html`, a zip/tar bomb (entries,
  depth, expanded bytes), an interrupted upload, a request with the same
  idempotency key and a different payload, a viewer or a limited key trying to
  deploy, another organization's artifact or preview id.

## Decisions requested before building

1. **Archive format.** Proposed: `.tar.gz` only for v1 (streams, no random access,
   simplest to bound). The CLI packages directories into it; the dashboard accepts
   the same file. Zip can be added later.
2. **Limits (all configurable, these are the defaults):** 50 MiB upload, 200 MiB
   expanded, 5,000 entries, path depth 16, 5 min upload timeout, 20 artifacts and
   10 live previews per organization.
3. **Storage:** artifacts on a controller-owned volume (`LAUNCHPAD_DATA_DIR`),
   content-addressed per organization; no object store yet.
4. **Roles and scopes.** Deployers and above can create previews and deploy;
   viewers read. New key scopes `preview:read` and `preview:deploy`; deploy keys
   are never project-restricted by omission (a restricted key may deploy only to
   previews of its listed projects).
5. **Hostnames.** `<slug>-<6 char id>.<LAUNCHPAD_PREVIEW_DOMAIN>`; the preview
   domain must be a separate registrable domain from the controller (existing
   decision) and defaults to `example.com` in docs and examples.
6. **Live engine tests.** They need a running Dokku. Proposed: an opt-in task,
   `omni -i run test:live -p @launchpad/worker`, that talks only to a disposable
   Dokku the developer started, creates apps with a `lp-test-` prefix, and removes
   only apps it recorded. It never runs in CI and never touches `view-demo`. You
   have authorized removing your existing Dokku and demo later; I will not start
   or stop them without being asked.

## Slices (one PR each; each leaves the system working and is safe to stop after)

1. **Data model and services (no Dokku, no upload).** Migrations for `preview`,
   `deployment`, `artifact`, `deployment_event` and `idempotency_key`; composite
   `(organization_id, id)` references so cross-organization links are impossible;
   generated app name and hostname (UI names never reach SSH); authorization
   matrix additions; services and contracts for create/list/get preview.
   _Verify:_ PostgreSQL tests for isolation, constraints, idempotency conflicts.
2. **Artifact upload and validation.** Authenticate before reading the body;
   stream to a temp file with byte/entry/depth/time limits; validate every entry
   (rules above); atomically finalize a content-addressed artifact; clean up
   interrupted uploads. Closes the milestone 1 gates for multipart/streamed
   bodies and the server-function size limit. _Verify:_ hostile-archive fixtures,
   interrupted/oversized/slow uploads, a streaming test through the built server,
   quotas, cross-organization artifact access.
3. **Dokku SSH adapter** (`packages/dokku`). A fixed operation vocabulary
   (create app, set domain, load image, deploy/ps status, destroy app), strict
   argument validation from generated names, pinned `known_hosts`
   (`StrictHostKeyChecking=yes`, `BatchMode=yes`, `IdentitiesOnly=yes`), timeouts,
   cancellation, bounded output, and a typed `uncertain` outcome. _Verify:_ a
   fake transport covering timeout-after-success, wrong host key, missing
   credentials and output limits. No live engine yet.
4. **Worker and deployment state machine** (`apps/worker`, feature off). pg-boss
   enqueue in the same transaction as the deployment; an attempt/fencing token
   checked on every state write and Dokku call; per-preview serialization;
   lease ownership; reconciliation of recorded app/image state before any retry;
   `reconciliation-needed` blocks further mutation of that preview. _Verify:_
   deterministic tests of every row in "complexities" above against the fake
   adapter, including stale-worker containment and database loss. **Safety gate:**
   Opus review of this slice before slice 5.
5. **Build, deploy and verify.** Fixed, versioned Nginx template (optional SPA
   fallback), a uniquely tagged image built by the worker, streamed to Dokku,
   proxy readiness probe with the right Host header, activation only after
   success, previous deployment kept on failure. Enabled by
   `LAUNCHPAD_DEPLOYMENTS=on`. _Verify:_ fixture and SPA behaviour, replacement
   failure preserving uptime, against a disposable engine via the opt-in live
   task; unit tests with the fake elsewhere.
6. **API, CLI, SDK and dashboard.** Endpoints from the design outline, SDK and
   client-core operations, `launchpad deploy ./dist --project … --name … --spa`,
   `previews list`, `deployments status`, polling progress, dashboard preview
   pages. Idempotency keys end to end. _Verify:_ contracts parsed against the
   live controller, CLI exit codes and JSON, role/scope/project-limit matrix.

## Verification and review

Each slice: Omni check/test/build/compose, PostgreSQL integration where data is
involved, an uncached Node-container check, CodeRabbit and CI. Slices 4–5 and the
milestone get an independent Opus review. Claims about live Dokku behaviour are
made only from the opt-in live task's output.

## Out of scope

Backends and databases, user Dockerfiles or build commands, MCP (milestone 4),
TTL, expiry, deletion and cleanup (milestone 5), packaging and publishing
(milestone 6), and any product rename or namespace registration.

## Progress

- Milestone 2 complete (PR #10 merged as `c935aea`).
- Plan approved as written (all six decisions) and merged in PR #11.
- [x] Slice 1: data model and services. Migration `…_010_previews` (artifact,
      preview, deployment, deployment_event, idempotency_key), composite
      organization references, generated `app_name`/hostname, one unfinished
      deployment per preview enforced by a partial unique index, `preview:*`
      actions (viewer reads; deployer creates and deploys), preview contracts and
      `createPreview`/`listPreviews`/`getPreview` with idempotency and a per-org
      cap (default 10, configurable). No HTTP, Dokku or upload yet; new API-key
      scopes arrive with slice 6.
- [x] Slice 2: artifact upload and validation. `POST …/artifacts` takes the
      `.tar.gz` as the request body (not multipart), authorizes before reading,
      streams to a private staging file under byte and time limits, validates every
      entry while streaming (types, names, secrets, duplicates, depth, entries,
      decompressed size, nested compression, `index.html`), and finalizes
      atomically under a per-organization lock into a content-addressed path.
      Deduplicates within an organization; hard ceiling of 20 artifacts until the
      cleanup milestone (an identical re-upload is refused when full; redeploy by id,
      or announce a digest to skip the upload, is a slice 6 candidate). Session only;
      API-key access with `preview:deploy` arrives in slice 6. Also closes the
      milestone 1 gaps for streamed bodies and `/_serverFn` size limits.
- [x] Slice 3: Dokku SSH adapter (`packages/dokku`). Fixed vocabulary (apps
      create/exists/destroy, domains:set, ports:set, git:load-image, ps:report), strict
      validation of generated names, pinned known_hosts and a private-key permission
      check re-verified on every call, a fail-closed ssh command line (`--` before the
      destination, `-F /dev/null`, minimal environment), timeouts, cancellation,
      bounded output, and a typed error taxonomy where `uncertain` (timeout,
      cancellation, dropped connection) must be reconciled. Unit-tested with fake
      transports and stand-in `ssh` executables; no live engine yet.
- [x] Slice 4: deployment state machine (`packages/services/src/deployments.ts`,
      migration `…_011_deployment_leases`). **Decision: no pg-boss for now.** The
      deployment row is the queue and the lease: enqueueing is the insert (same
      transaction by construction), `claimNext` uses `FOR UPDATE SKIP LOCKED`, and the
      per-preview unique index already serializes work. The spike's revisit clause
      applies: this fences stale attempts with one mechanism instead of two, at the
      cost of polling (`claimNext`) rather than push. Steps `app, build, configure,
      load, verify`, intent recorded (fenced) before each; a stale attempt is refused
      on its next write and Dokku calls are aborted at 80% of the lease. Only an image
      load with an unknown outcome parks the preview (`reconciliation-needed`,
      resolved by an admin via `resolveReconciliation`); the other steps are
      idempotent and simply re-run. Off by default (`deploymentsEnabled`). The
      `apps/worker` process that polls `claimNext` and supplies real `DeployPorts`
      arrives with slice 5, when there is something real to run.
- [ ] Slices 5–6.
