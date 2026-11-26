# Deployment worker

The worker stays idle and healthy with `LAUNCHPAD_DEPLOYMENTS=off` (the
default). It does not connect to PostgreSQL, Docker or Dokku in that mode.
With deployments enabled, it claims queued jobs, builds the fixed static-site
image, and loads it into that deployment's own Dokku app. It does not roll
back, expire deployments or process aliases. It also runs queued manual deletions: it
destroys only the recorded app of the deployment (never a name that deployment did not create),
confirms the app is gone, and removes that deployment's exact local image tag.

See the [installation guide](../../docs/install.md) for enabled settings,
shared storage and the stop grace period. The deployment's source image tag is
owned exclusively by Launchpad: do not retag or replace it, or prune the engine
while workers are active. The worker checks the recorded image ID before
saving the required tag for Dokku.

Run enabled workers under a supervisor that restarts them on failure. If a
database operation stalls past the worker's deadline, the worker cancels
dispatch, closes its PostgreSQL connections, and exits nonzero. Restarting
does not replay an unconfirmed remote effect.

## Run it on the host

For development, `omni -i run dev -p @launchpad-kit/worker` runs `bun --watch src/index.ts` in
`apps/worker` and loads `apps/worker/.env.local`. With deployments on it needs the settings listed in
`.env.local.example`, a Docker CLI you may use, and a reachable Dokku and PostgreSQL;
`omni -i run dev:infra:up -a "options=--preset deploy"` starts those and writes the complete file to
`.dev-infra/env/worker.env` (see [develop against local infrastructure](../../docs/local-dev-infra.md)).
`LAUNCHPAD_DATA_DIR` must be the same absolute directory as the controller's.

## Recover build scratch space

The worker removes its own build context when it returns normally. A forced
stop can leave expanded archive contents on disk; startup does not sweep them
because other workers might still be using them. If scratch space needs
cleanup, stop **all** workers using the shared data directory, verify the
mount and confirm no dispatched build still needs its context. List the
immediate children of `$LAUNCHPAD_DATA_DIR/build`, then remove only confirmed
abandoned directories by exact path. Launchpad's scratch directory names use
`b-` followed by six alphanumeric characters. Do not remove the build root,
artifact storage or maintenance files. This procedure does not resolve the
deployment's database reconciliation status.

## Tests

`omni -i run test:integration -p @launchpad-kit/worker` uses disposable
PostgreSQL and fake effect ports. The opt-in `test:live` suite uses real Docker
and Dokku; it checks static serving, SPA fallback, separate deployment
hostnames and exact-name deletion. It must only run against authorized
disposable infrastructure. See `src/__tests__/live.spec.ts` for its settings.
