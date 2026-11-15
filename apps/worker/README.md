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
  with Launchpad's fixed, versioned template. There is no user Dockerfile and no
  build command: the only inputs are the deployment id, the SPA switch and a validated
  base image reference. Docker runs without a shell, with `--network none`, and only
  with tags and directories this worker makes. The scratch directory is always
  removed.
- **load** (`ports.ts`): `docker save` is streamed to Dokku's `git:load-image`; a failure
  of either side fails the step, and the local image is removed afterwards.
- **verify** (`verify.ts`): asks the proxy for the preview's hostname until it answers
  200 _with this deployment's id_ in `X-Launchpad-Deployment`, so an older container
  still serving does not count.

## Not yet

Rolling back to the previous image after a failed verify (the preview is held for an
administrator instead), and the opt-in live test against a disposable Dokku.
