# Launchpad

Custom Dokku image with the `http-auth` plugin for local deployments.

The controller has operator login, organizations, members, projects, optional
email invitations and recovery, and an OpenAPI reference. The earlier preview deployment runtime was
removed. Its replacement, the immutable app model, is switched off by default
(`LAUNCHPAD_DEPLOYMENTS`); when on, apps, uploads, deployments and manual deletion work through the API
and an enabled worker. With aliases enabled separately, promote an existing deployment to a stable
hostname without rebuilding it. See the [dashboard, CLI, MCP and API deployment guide](docs/deployments.md).
Nothing is published or deployed from this
repository's CI except by one gated workflow, `.github/workflows/release.yaml`, which runs only when a maintainer pushes a `v<semver>` tag and waits for approval of the `release` environment (see the [release publishing decision](docs/decisions/release-publishing.md) and [releasing](docs/releasing.md)); it has not run yet. A production-shaped Compose stack exists but has never run as production (see [production Compose](docs/production-compose.md)). See
[Controller](#controller) below, [the controller README](apps/controller/README.md) and
[the worker README](apps/worker/README.md).

## Run it locally

To try the controller, dashboard and CLI on your own machine, follow
[run Launchpad on your machine](docs/local-quickstart.md): a development server, any PostgreSQL 17,
and one seed command (`omni -i run local:seed`) that creates the accounts, an organization, a project
and a saved CLI profile. To deploy `examples/hello` on your machine with Docker (controller, worker,
Dokku and router, removed again by one command), follow [deploy a site on your machine](docs/local-deploy.md) (it mounts the host Docker socket into
the worker and Dokku, which is root-equivalent on your machine). To develop the apps themselves on the
host against PostgreSQL, the Adminer SQL client, Mailpit, Dokku and the router in Docker, follow
[develop against local infrastructure](docs/local-dev-infra.md) (`omni -i run dev:infra:up`).

## Configuration

`docker-compose.yaml` defines the whole stack (PostgreSQL, controller, worker, Dokku and
the alias router); see [production Compose](docs/production-compose.md). Copy the example
and replace every `CHANGE_ME`:

```sh
cp docker-compose.env.example docker-compose.env
```

`docker-compose.env` is ignored by Git and excluded from Docker build contexts. Keep
plugins and other image customizations in `containers/dokku/Dockerfile`.

Compose does not load `docker-compose.env` on its own: pass `--env-file docker-compose.env`
on every command. Exported shell variables override values in that file. The host paths in
it (`DOKKU_DATA_DIR` and the credential files) must exist and be absolute physical paths.

## Run

Validate the configuration, then build and start only Dokku (the other services need
their credential files and are described in [production Compose](docs/production-compose.md)):

```sh
docker compose --env-file docker-compose.env config --quiet
docker compose --env-file docker-compose.env up -d --build --wait --wait-timeout 420 dokku
docker compose --env-file docker-compose.env exec dokku dokku apps:list
```

Dokku's published ports are loopback-only by default (SSH 32222, HTTP 32181,
HTTPS 32443; see the bindings in `docker-compose.env.example`). Its Docker socket mount
grants host-level control, so only deploy trusted workloads. Dokku state persists in
`DOKKU_DATA_DIR`; changing that path does not migrate state. App volumes and databases need
their own backup handling.

## Test project

`examples/hello/` contains a minimal static Nginx site. With Dokku running:

```sh
docker compose --env-file docker-compose.env exec dokku \
  dokku network:set --global initial-network launchpad-apps
docker build -t launchpad/hello:v1 examples/hello
docker compose --env-file docker-compose.env exec dokku dokku apps:create hello
docker compose --env-file docker-compose.env exec dokku dokku git:from-image hello launchpad/hello:v1
```

Use your configured `LAUNCHPAD_APPS_NETWORK` instead if you changed its default.
Use a new image tag for each update and pass it to `git:from-image` again; an unchanged
tag can cause Dokku to skip deployment. The app is public: installing `http-auth` does not
enable password protection.

## Controller

Launchpad is being shaped as a controller and dashboard around Dokku, with a CLI
that talks to the controller. The workspace follows Pureform's Bun/Omni layout:

```text
apps/
  controller/      TanStack Start + React, mounted Elysia 2 RC API, Skeleton 5
  worker/          Deployment worker (idle unless LAUNCHPAD_DEPLOYMENTS=on; builds, loads and deletes)
  cli/             Bun CLI: profiles, projects, apps, deployments, aliases
  mcp/             Local stdio MCP server (read-only by default)
packages/
  auth/            Better Auth configuration, operator setup and recovery, mailer
  contracts/       Versioned API shapes (zod only, browser-safe)
  sdk/             Browser-safe HTTP client for the API, authenticated with an API key
  client-core/     Profiles and the credential file shared by the CLI and MCP
  services/        Framework-independent services and authorization
  database/        Kysely on Bun SQL, forward-only migrations
  dokku/           Allowlisted Dokku operations over SSH with a pinned host key
  tsconfig/        Shared TypeScript configuration
  vite-config/     Shared package build configuration
  vitest-config/   Shared test configuration
omni/
  generators/      TypeScript scaffolding copied/adapted from Pureform
  presets/         Shared Omni project tasks
tooling/           Repository-wide Omni tasks and checks (dependency consistency, test database)
```

The workspace also reserves `tests/*` for future cross-package test projects.
Dependencies, docs and skills can be installed without launching anything:

```sh
bun install --frozen-lockfile
omni remote-sources install && omni projection sync
omni -i run check test build
```

Omni is the entrypoint for every task (build, checks, tests, the dev server, operator
commands, the disposable test database); see [CONTRIBUTING.md](CONTRIBUTING.md#tasks).

Build generates the ignored TanStack route tree and production Bun output; it
does not start the app. The controller Dockerfile is in
`apps/controller/Dockerfile` (and the worker's in `apps/worker/`), separate from the Dokku image in `containers/dokku/` (`containers/` holds images of external software).

Authentication, organizations, projects and email flows are implemented and tested against a disposable PostgreSQL (and, opt-in, a disposable
Dokku); see the controller and worker READMEs for configuration and first run.

See [CONTRIBUTING.md](CONTRIBUTING.md), [tooling](docs/tooling.md), and
[package patterns](docs/patterns/README.md), and [deployments](docs/deployments.md). Keep these docs current when setup
or boundaries change.

## License

Launchpad is licensed under the [Apache License 2.0](LICENSE).
