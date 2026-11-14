# Launchpad

Custom Dokku image with the `http-auth` plugin for local preview deployments.

The controller has operator login, organizations, members, projects, optional
email invitations and recovery, and an OpenAPI reference. It does **not deploy
anything yet**: uploads, jobs and the Dokku worker are later milestones (see
[the plan](docs/plans/application.md)). See [Controller](#controller) below and
[the controller README](apps/controller/README.md). The Docker commands in the
earlier sections manage the existing Dokku engine, not the controller.

## Configuration

On a fresh checkout, copy the example and edit `.env.local`:

```sh
cp .env.local.example .env.local
```

`.env.local.example` documents all supported settings. `.env.local` is ignored
by Git and excluded from the Docker build context. Keep plugins and other image
customizations in `Dockerfile`.

Compose does not automatically load `.env.local`. Pass `--env-file .env.local`
on every command. Exported shell variables override values in that file.
Run commands from the repository root: `DOKKU_DATA_DIR=${PWD}/.data/dokku`
keeps Dokku state in the Git-ignored `.data/dokku/` directory while providing
absolute host paths for Docker bind mounts. Use the physical repository path
(not a symlink) so Dokku's sibling containers resolve mounts correctly.

## Run

Validate configuration, then build and start:

```sh
docker compose --env-file .env.local config --quiet
docker compose --env-file .env.local up -d --build
```

Check status and interact with Dokku:

```sh
docker compose --env-file .env.local ps
docker compose --env-file .env.local logs -f dokku
docker compose --env-file .env.local exec dokku dokku apps:list
```

If this is an existing installation, explicitly update its global app domain
after changing `DOKKU_HOSTNAME`:

```sh
docker compose --env-file .env.local exec dokku dokku domains:set-global example.com
```

Replace `example.com` with your configured hostname. Existing app domains may
need separate updates; inspect them with `dokku domains:report <app>`.

## Cloudflare Tunnel

For cloudflared running on the host, route `*.example.com` to
`http://127.0.0.1:9080`. Match the address and port to `DOKKU_BIND_IP` and
`DOKKU_HTTP_PORT`; leave the HTTP Host Header override unset.

An app named `view-demo` uses `view-demo.example.com`. Cloudflared in a
container cannot reach the host through its own `127.0.0.1`; that setup needs
separate networking configuration.

The default published ports are local-only. Dokku's Docker socket mount grants
host-level control. Only deploy trusted workloads. Enable `http-auth` separately
for each app that needs protection, and use HTTPS when sharing credentials.

Dokku state persists in `DOKKU_DATA_DIR`. Changing that path does not migrate
state. App volumes and databases require their own backup and lifecycle handling.
Docker-managed images, containers, build cache, and volumes still live in the
host Docker engine's storage; this setting only relocates Dokku's state.

## Test project

`examples/hello/` contains a minimal static Nginx site. After starting Dokku:

```sh
docker compose --env-file .env.local up -d --wait --wait-timeout 180
docker build -t launchpad/hello:v1 examples/hello
# Only create the app on its first deployment.
docker compose --env-file .env.local exec dokku dokku apps:create view-demo
docker compose --env-file .env.local exec dokku dokku git:from-image view-demo launchpad/hello:v1
```

After configuring your own domain in place of `example.com`, open
`https://view-demo.example.com` using that domain. For a local
check without DNS or the tunnel:

```sh
curl --fail -H 'Host: view-demo.example.com' http://127.0.0.1:9080
```

Use a new image tag (for example `v2`) for each update and pass that tag to
`git:from-image` again. An unchanged tag can cause Dokku to skip deployment.
The demo is public; installing `http-auth` does not enable password protection.

The containerized setup can warn that its port-listening deployment check
cannot enter a sibling container's PID namespace. The demo passed the uptime
check and HTTP verification, but that warning means the port check did not run.
Sharing the host PID namespace would expand host access and is not enabled here.

## Controller

Launchpad is being shaped as a controller and dashboard around Dokku, with a CLI
that talks to the controller. The workspace follows Pureform's Bun/Omni layout:

```text
apps/
  controller/      TanStack Start + React, mounted Elysia 2 RC API, Skeleton 5
  cli/             Bun CLI (help/version only so far)
packages/
  auth/            Better Auth configuration, operator setup and recovery, mailer
  services/        Framework-independent services, authorization and API contracts
  database/        Kysely on Bun SQL, forward-only migrations
  dokku/           Dokku connection boundary; no SSH execution yet
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
omni run check test build
```

Omni is the entrypoint for every task (build, checks, tests, the dev server, operator
commands, the disposable test database); see [CONTRIBUTING.md](CONTRIBUTING.md#tasks).

Build generates the ignored TanStack route tree and production Bun output; it
does not start the app. The controller Dockerfile is in
`apps/controller/Dockerfile`, separate from the root Dokku image.

Authentication, organizations, projects and email flows are implemented and
tested against a disposable PostgreSQL; see the controller README for
configuration and first run. Deployment commands, uploads/jobs and SSH
connectivity are not implemented. No controller or PostgreSQL service has been
added to Compose.

See [CONTRIBUTING.md](CONTRIBUTING.md), [tooling](docs/tooling.md), and
[package patterns](docs/patterns/README.md). Keep these docs current when setup
or boundaries change.
