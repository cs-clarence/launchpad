# Worker

The privileged half of deployments. It polls the database for deployments
(`claimNext`), runs each through the state machine in `@launchpad/services`, and is the
only process that holds Dokku SSH credentials and Docker access. The HTTP controller
has neither. Keep this page current when settings or steps change.

Off unless `LAUNCHPAD_DEPLOYMENTS=on`; while off it idles and reads no other setting.

## Settings

| Variable                                                                                       | Meaning                                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `LAUNCHPAD_DEPLOYMENTS`                                                                        | `on` or `off` (default `off`); anything else is an error                                                                                     |
| `DATABASE_URL`, `LAUNCHPAD_DATA_DIR`                                                           | same as the controller; artifacts are read from the data directory                                                                           |
| `DOKKU_SSH_HOST`, `DOKKU_SSH_PORT` (22), `DOKKU_SSH_USER` (`dokku`)                            | the Dokku host                                                                                                                               |
| `DOKKU_SSH_KEY_PATH`, `DOKKU_SSH_KNOWN_HOSTS_PATH`                                             | key (mode 600) and the host key pinned out of band; see `packages/dokku`                                                                     |
| `LAUNCHPAD_PREVIEW_PROXY_URL`                                                                  | where the worker reaches Dokku's proxy for the readiness probe, e.g. `http://dokku:80` (no DNS needed; the preview's name is sent as `Host`) |
| `LAUNCHPAD_BASE_IMAGE`                                                                         | the web server image, default `nginx:1.27-alpine`; pin by digest in production                                                               |
| `LAUNCHPAD_DOCKER_BIN`, `DOCKER_HOST`                                                          | the Docker client and engine                                                                                                                 |
| `LAUNCHPAD_WORKER_ID`, `LAUNCHPAD_WORKER_POLL_MS` (2000), `LAUNCHPAD_WORKER_LEASE_MS` (900000) | identity, polling and lease                                                                                                                  |

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
rolling back. It is opt-in, never part of `test` or CI, and needs a **disposable** Dokku
you start yourself. It only creates apps named `lp-test-<6 characters>`, records them,
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
