# Worker

The privileged half of deployments. It polls the database for deployments
(`claimNext`), runs each through the state machine in `@launchpad/services`, and is the
only process that holds Dokku SSH credentials and Docker access. The HTTP controller
has neither. Keep this page current when settings or steps change.

Off unless `LAUNCHPAD_DEPLOYMENTS=on`; while off it idles and reads no other setting.
Scheduled expiry, deletion and artifact cleanup are a second, separate switch,
`LAUNCHPAD_LIFECYCLE=on` (default `off`); see [Lifecycle](#lifecycle).

## Settings

| Variable                                                                                                                                                                                            | Meaning                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LAUNCHPAD_DEPLOYMENTS`                                                                                                                                                                             | `on` or `off` (default `off`); anything else is an error                                                                                                                                                                  |
| `DATABASE_URL`, `LAUNCHPAD_DATA_DIR`                                                                                                                                                                | same as the controller; the data directory is shared with it and must be readable and writable by the **same user** (the worker builds in `build/` and collects, moves and restores archives, which the controller wrote) |
| `DOKKU_SSH_HOST`, `DOKKU_SSH_PORT` (22), `DOKKU_SSH_USER` (`dokku`)                                                                                                                                 | the Dokku host                                                                                                                                                                                                            |
| `DOKKU_SSH_KEY_PATH`, `DOKKU_SSH_KNOWN_HOSTS_PATH`                                                                                                                                                  | key (mode 600) and the host key pinned out of band; see `packages/dokku`                                                                                                                                                  |
| `LAUNCHPAD_PREVIEW_PROXY_URL`                                                                                                                                                                       | where the worker reaches Dokku's proxy for the readiness probe, e.g. `http://dokku:80` (no DNS needed; the preview's name is sent as `Host`)                                                                              |
| `LAUNCHPAD_BASE_IMAGE`                                                                                                                                                                              | the web server image, default `nginx:1.27-alpine`; pin by digest in production                                                                                                                                            |
| `LAUNCHPAD_DOCKER_BIN`, `DOCKER_HOST`                                                                                                                                                               | the Docker client and engine                                                                                                                                                                                              |
| `LAUNCHPAD_WORKER_ID` (hostname-pid; 1 to 128 characters), `LAUNCHPAD_VERSION` (shown to the operator; `unknown` if unset), `LAUNCHPAD_WORKER_POLL_MS` (2000), `LAUNCHPAD_WORKER_LEASE_MS` (900000) | identity, polling and lease                                                                                                                                                                                               |

## What a deployment does

`app` (create the Dokku app if missing) → `build` → `configure` (domain, port) →
`load` → `verify` → activate. The state machine owns ordering, leases and recovery
(see `docs/plans/milestone-3-static-preview.md`); this package supplies the real
steps:

- **build** (`build.ts`, `extract.ts`, `template.ts`): the stored archive is validated
  again, extracted with a filter that admits only files and directories, and built
  with Launchpad's fixed, versioned template (a rollback is rebuilt with the template of the worker that runs it, which may be newer than the one that built the original). There is no user Dockerfile and no
  build command: the only inputs are the deployment id, the SPA switch and a validated
  base image reference. Docker runs without a shell, with `--network none` (which only affects `RUN` steps; this template has none, and the base image is fetched by the engine itself), and only
  with tags and directories this worker makes. The scratch directory is always
  removed.
- **load** (`ports.ts`): `docker save` is streamed to Dokku's `git:load-image`; a failure
  of either side fails the step, and the local image is removed afterwards.
- **verify** (`verify.ts`): asks the proxy for the preview's hostname until it answers
  200 _with this deployment's id_ in `X-Launchpad-Deployment`, so an older container
  still serving does not count.

## A failed verify

If the new image loaded but does not become ready, the previous release is restored: it
is rebuilt from its own stored artifact with the same fixed template, loaded, and probed
for _its own_ id (`rollback` in `ports.ts`; restoring is the ordinary path, not a second
way to change what is running). The deployment ends `failed` (`verify-failed-rolled-back`)
and the previous deployment stays active. With nothing to restore (a first release) it
ends `failed` (`verify-failed`). If the rollback itself fails, or a worker stops in the
middle of one, the preview is held for an administrator (`reconciliation-needed`). A rollback
is given twice the usual lease, since it builds, loads and probes in one go.

## Live tests

`omni -i run test:live -p @launchpad/worker` runs the worker's real steps against a real
Dokku and Docker: the fixture site, a real 404, SPA deep links, replacing a release and
rolling back, and destroying one app with the worker's real destroy port while a neighbour
app is left alone (the ports are called directly; `runDeletion` itself is tested against fakes).
It is opt-in, never part of `test` or CI, and needs a **disposable** Dokku (the throwaway
container the test setup describes). It only creates apps named `lp-test-<6 characters>`, records them,
and destroys only those at the end; it never touches any other app. Without its settings
it fails at once with a message. The settings are listed at the top of
`src/__tests__/live.spec.ts`.

## Running it

- A load or rollback in progress is not interrupted by a shutdown (a half-loaded image is
  worse than a slow stop). A load can take up to about 11 minutes and a rollback up to
  1.6 times the lease (24 minutes with the default), so give the process a stop timeout
  of at least 1.6 times the lease plus a margin (25 minutes by default); a SIGKILL
  mid-load or mid-rollback leaves the deployment held for reconciliation.
- Startup removes scratch build directories older than an hour that a killed worker left
  behind. Images are removed after each load; an image built but never loaded (a failure
  before the load) stays in the local engine until removed by hand: there is no global
  prune, on purpose.
- Failure details (a failed build's output, say) are kept on the error for operators but
  are not logged yet; the log lines carry only outcomes.

## Lifecycle

Off unless `LAUNCHPAD_LIFECYCLE=on` (and deployments are on). Between deployments the worker
then does three things, in this order, each bounded: it **claims previews whose lifetime has
run out** (queueing their deletion), **runs at most one deletion**, and, every ten minutes,
**collects archives and sweeps orphaned archive files**. Settings: `LAUNCHPAD_DEFAULT_TTL`,
`LAUNCHPAD_MAX_TTL`, `LAUNCHPAD_ALLOW_NO_EXPIRY`, `LAUNCHPAD_ARTIFACT_RETENTION` (see the
controller README; the lifetimes are applied by the controller when a preview is created or
extended, and only the retention changes what the worker does); a value that is set but invalid
stops the worker at startup. Set `LAUNCHPAD_LIFECYCLE` on the controller too.

A deletion destroys **one Dokku app and one preview's own images, nothing else**:

- the app is destroyed only if its recorded name is of the generated kind (`lp-` and ten
  letters or digits), and the Dokku client independently refuses any other name; the worker
  asks `apps:exists` before every destroy, so a destroy whose answer was lost is not repeated
  (and if the app is still there, it is tried again within five attempts, then held for an
  administrator, who resolves it);
- images are removed by their exact recorded tag (`docker rmi --force <tag>`), and an image
  that cannot be removed does not block the deletion (it is recorded as `images-left-behind`);
- there is no prune, no volume, no network, no database and no listing in the vocabulary,
  and a test reads the sources and fails if one appears.

Archives are collected only when older than the retention, not pointed at by any deployment of
a preview that is not deleted (a live preview keeps the archive its rollback is rebuilt from),
not by an unfinished deployment, and not by a preview deleted within the retention. The row
stays (marked collected) and the file goes after it; uploading the same bytes again stores the
archive again. Switch the lifecycle off to stop all of this at once: nothing is deleted, and
all rows and jobs are kept.

### Heartbeat

The worker writes a row (`worker_heartbeat`: id, version, whether it runs the lifecycle, when it
started, when it last reported) when it starts and every 10 s after, from a timer of its own, so
a long build does not make it look dead. A failed write is logged (`heartbeat-error`, no detail)
and the work goes on. The operator reads these through `GET /api/v1/status` (see the controller
README), which also warns when the controller and the workers disagree about the lifecycle.

### Things to know before switching the lifecycle on

- Use one database per Dokku host and per data directory. "Owned" means "has a row in this
  database", so a second installation (or a database copied from production) pointed at the same
  Dokku or data directory would destroy or sweep the first one's apps and archives.
- The first time the lifecycle is switched on, every preview that would expire within 24 h
  (overdue or about to be) gets 24 h from then, once (recorded in the database), instead of being
  deleted within minutes or hours. Switching it off and on again later gives no grace: what expired
  meanwhile is deleted, as after any downtime. Previews carry an expiry from creation even while the
  lifecycle is off, so check them (the dashboard shows each expiry) before the first switch-on.
- The controller and the worker read `LAUNCHPAD_LIFECYCLE` separately; set both. The controller
  refuses a new deletion unless both it and deployments are on.
- Images loaded onto the Dokku host with `git:load-image` are not removed by the worker; only
  the worker's own Docker daemon is cleaned. Resolving a held deletion as "deleted" trusts the
  administrator and removes no images.
- Shutdown may wait out a Dokku destroy of up to about a minute; this is safe because the next
  attempt asks whether the app still exists first.
- The artifact retention must be at least 1h.
