# Develop against local infrastructure

For a developer who changes the controller, worker, CLI or dashboard and wants PostgreSQL, a mail
catcher and a working deployment target on their machine, without running the apps in Docker. One
command starts PostgreSQL, the Adminer SQL client, Mailpit, Dokku and the alias router; the controller, worker and CLI run on
the host from your checkout. It is the infrastructure-only counterpart of
[deploy a site on your machine](local-deploy.md) (everything in Docker, one `hello` deployment), and
extends [run Launchpad on your machine](local-quickstart.md).

## Read this first

- This mounts the host Docker socket into Dokku. That is **root-equivalent on your machine**. Run it
  only on a machine you would trust with that, never on a shared or production host.
- Everything binds `127.0.0.1` and must stay that way. The tool has no option to change it. The router
  control port speaks plain HTTP (no certificates) and the control token crosses it on loopback only.
- Dokku's first start installs unpinned packages from the internet (accepted for production Compose too).
- The generated keys, token and passwords live in `.dev-infra/` in the checkout. Treat them as
  secrets; do not commit or share them. Nothing prints them.
- `dev:infra:destroy` deletes the database, every deployment and the key files. `dev:infra:down` does
  not.
- Mailpit keeps mail in memory only: it is gone after `dev:infra:down`.
- Deployments and the dashboard cannot both work at once (see [Two presets](#two-presets)).
- Adminer has no login of its own: it is an unauthenticated UI that relies on the loopback bind and
  the database password. Do not forward its port or publish it.
- This is not a production install, and `docker-compose.dev.yaml` is not a template for one.

You need Linux with native Docker Engine and Docker Compose v2 (not Docker Desktop, rootless Docker,
Podman or a remote `DOCKER_HOST`), [Bun](https://bun.sh) 1.4.4, [Omni](https://github.com/omni-oss/omni),
`ssh-keygen`, `git` and a checkout of this repository. Run every command from the repository root. The
worker builds sites with your own `docker` command, so your user needs Docker access, which it already
has.

## Start it

1. Install the dependencies and the agent context:

    ```sh
    bun install --frozen-lockfile
    omni remote-sources install && omni projection sync
    ```

2. Start the infrastructure:

    ```sh
    omni -i run dev:infra:up
    ```

    It checks Docker, that `.dev-infra/` is ignored by git and that the ports are free, writes
    `.dev-infra/` (mode 700) with its record first, builds the Dokku and router images under tags of
    its own (`launchpad-dev-<hash>/<service>:local`), starts PostgreSQL, Adminer, Mailpit and Dokku,
    pins Dokku's host key and registers the worker's key, initialises the router once, starts the
    router and writes the settings for the host apps to `.dev-infra/env/`. It is safe to run again: it keeps
    what exists and skips the one-time steps. Dokku's first start takes minutes.

3. Copy the generated settings into the apps. The tool never writes an app's `.env.local`:

    ```sh
    install -m 600 .dev-infra/env/controller.env apps/controller/.env.local
    ```

4. Run the controller in one terminal and seed it from another:

    ```sh
    omni -i run dev -p @launchpad-kit/controller
    omni -i run dev:infra:seed
    ```

    The seed applies the migrations and creates the operator, the owner, the organization `local`, the
    project `demo` and a CLI profile `dev-infra`. Build the CLI once as in the
    [quickstart](local-quickstart.md#set-it-up) (step 6) to use it.

Open the dashboard at `http://127.0.0.1:3000` and Mailpit at `http://127.0.0.1:38025`. To read or fix
rows by hand, open Adminer at `http://127.0.0.1:38080`, choose PostgreSQL and log in with server
`postgres`, user and database `launchpad`, and the password from `.dev-infra/compose.env`. Read and
write are both allowed, exactly as with `psql`; nothing is exposed beyond loopback. An invitation
sent from the dashboard (the controller runs with `LAUNCHPAD_ENROLLMENT=invitation`) shows up in
Mailpit.

## What it costs

Measured once on a Linux workstation with warm Docker layer and base-image caches, before Adminer
joined the stack (its image adds a pull on the first run) (a cold first run was
not measured; Dokku's first start alone took 4.5 minutes in an earlier rehearsal):

| What                                              | Measured                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| First `dev:infra:up` (warm caches)                | 131 s, most of it Dokku's first start                            |
| `dev:infra:up` again after `down`                 | 19 s; a stopped site answers again about 30 s later              |
| `dev:infra:down`                                  | 12 s                                                             |
| `dev:infra:destroy` with one deployed site        | 8 s                                                              |
| One deployment of `hello` through the host worker | 72 s from `app deploy` to `succeeded`                            |
| Memory limits in Compose                          | PostgreSQL 512 MiB, Dokku 1 GiB, router 128 MiB, Adminer 1.5 GiB |

Builds and deployed sites run in the host engine, outside the memory limits. Pulled base images (Mailpit,
PostgreSQL, Adminer, Dokku) and the build cache stay after `destroy`.

## Two presets

The controller requires an `https` `LAUNCHPAD_BASE_URL` on a different registrable domain from the apps
domain as soon as deployments are on, so one host controller cannot serve a working dashboard on
`http://127.0.0.1:3000` and deploy. `up` writes one of two presets:

| Preset          | Controller settings                                                   | Dashboard, Mailpit invitations | Deployments |
| --------------- | --------------------------------------------------------------------- | ------------------------------ | ----------- |
| `app` (default) | `LAUNCHPAD_DEPLOYMENTS=off`, base URL `http://127.0.0.1:3000`         | work                           | off         |
| `deploy`        | `LAUNCHPAD_DEPLOYMENTS=on`, base URL `https://control.localhost:8443` | do not work (CLI and API only) | on          |

Switch with `omni -i run dev:infra:up -a "options=--preset deploy"` (add `--aliases off` to leave
aliases off; they are on by default), copy the new files over the apps' `.env.local` and restart the
apps. The deploy preset also writes `.dev-infra/env/worker.env`:

```sh
install -m 600 .dev-infra/env/controller.env apps/controller/.env.local
install -m 600 .dev-infra/env/worker.env apps/worker/.env.local
omni -i run dev -p @launchpad-kit/controller
omni -i run dev -p @launchpad-kit/worker
omni -i run dev:infra:seed -a "options=--new-key"
```

The `--new-key` makes the seed issue a key with the deploy scopes (a key saved by the `app` preset lacks them and is refused otherwise) (and the alias scopes when aliases are on). Deploy
`examples/hello` as in [deploy a site on your machine](local-deploy.md#set-it-up) (steps 3 to 5) with
`LAUNCHPAD_PROFILE=dev-infra`. The Dokku HTTP port is `33181`: send the host name yourself,
`curl -H "Host: <hostname>" http://127.0.0.1:33181/`. The dashboard's preview link has no port, so it
does not work, as in `local:deploy`. Mailpit is exercised only in the `app` preset: mail is sent from
dashboard flows, and the dashboard does not work in `deploy`.

Settings the controller and the worker must agree on beyond these (the stale-after setting and the
archive limits, see [production Compose](production-compose.md)) must be copied to both files by hand.
`LAUNCHPAD_DATA_DIR` is an absolute path in `.dev-infra/data`, because a relative path would resolve
differently in each app.

## Ports

Every port is published on `127.0.0.1` only and avoids the ports of `local:deploy` (32180 to 32443),
`test:db:up` (55432) and the quickstart's PostgreSQL (5432).

| Service        | Default | Variable (set it before the first `up`) |
| -------------- | ------- | --------------------------------------- |
| PostgreSQL     | 35432   | `DEV_POSTGRES_PORT`                     |
| Adminer        | 38080   | `DEV_ADMINER_PORT`                      |
| Mailpit SMTP   | 31025   | `DEV_SMTP_PORT`                         |
| Mailpit web    | 38025   | `DEV_MAILPIT_UI_PORT`                   |
| Dokku SSH      | 33222   | `DEV_DOKKU_SSH_PORT`                    |
| Dokku HTTP     | 33181   | `DEV_DOKKU_HTTP_PORT`                   |
| Router data    | 33182   | `DEV_ROUTER_DATA_PORT`                  |
| Router control | 33183   | `DEV_ROUTER_CONTROL_PORT`               |

Ports 3000 (the controller), 5432 and 55432 (the quickstart and test databases) and 32180 to 32443
(`local:deploy`) are refused as overrides.

The ports are fixed by the first `up` and recorded in `.dev-infra/compose.env`. Dokku's HTTPS port is
not published.

## Day to day

```sh
omni -i run dev:infra:status
omni -i run dev:infra:logs -a "options=--service dokku"
omni -i run dev:infra:down
omni -i run dev:infra:up
omni -i run dev:infra:destroy
```

- `dev:infra:status` prints each service's health, the ports and the deployed sites. If PostgreSQL
  runs but the `deployment` table does not exist yet (before the first migration), it says the schema
  has not been migrated, points to `dev:infra:seed`, and keeps the recorded inventory. If the database
  cannot be reached at all it says so and also keeps the inventory.
- `dev:infra:down` stops the services and the Dokku site containers (they live outside the Compose
  project and would otherwise keep running and block removal of the network) and keeps the database,
  Dokku state, credentials and images. `dev:infra:up` starts it again; Dokku restarts the sites.
- `dev:infra:destroy` removes everything it created: the Dokku sites and their images, the containers,
  volumes and network, the images, the root-owned Dokku state and `.dev-infra/`. It removes only what
  carries the project's labels and exact names it recorded, never by prefix or prune. The apps' own
  `.env.local` files are not touched; delete the ones you copied.
- A Mailpit message is gone after `down`.

For ad-hoc use after the first `up`, the same Compose project works with raw commands:

```sh
docker compose -p <project> --env-file .dev-infra/compose.env -f docker-compose.dev.yaml ps
```

`<project>` is the name `up` printed (`launchpad-dev-<hash of the checkout path>`). Do not run Compose's own
`down` instead of `dev:infra:down`: it cannot remove the apps network while Dokku site containers are attached.

It can sit next to `local:deploy` (different project, directory, images, network and ports), but each
runs its own Dokku, so run one at a time.

## What is in `.dev-infra/`

A `.dev-infra/` directory without a `state.json` that holds only the fixed children (`dokku`,
`credentials`, `data`, `env`) is treated as an interrupted run and wiped by `destroy`, so do not keep
your own files in those directories. The root helper that removes the root-owned `dokku/` runs as root
with no network and a bind of `.dev-infra/` only; it has no further hardening.

| Path                                   | What                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `compose.env`                          | Generated Compose settings: passwords, ports, project name (mode 600)                                 |
| `dokku/`                               | Dokku state, root-owned; the SSH host key survives `down`, so `known_hosts` stays valid               |
| `credentials/`                         | The worker's SSH key, `known_hosts` (`[127.0.0.1]:33222 ssh-ed25519 ...`), the router token and epoch |
| `data/`                                | `LAUNCHPAD_DATA_DIR`, shared by the host controller and worker                                        |
| `env/controller.env`, `env/worker.env` | The generated settings of the host apps                                                               |
| `state.json`                           | The record that ties the directory to this checkout and project                                       |

## If it fails

Each failure prints one message and exits nonzero. `up`, `down` and `destroy` can be run again.

| Message mentions                                     | What to do                                                                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a port in use                                        | Set the `DEV_*_PORT` variable for it (table above) before the first `up`, or free it.                                                                                         |
| `not ignored by git`                                 | `.dev-infra` is missing from `.gitignore`; add it.                                                                                                                            |
| `exists without a state.json`                        | Something else is in `.dev-infra/`; look, then remove it by hand.                                                                                                             |
| `another up running`                                 | Two `up` commands ran at once and this one changed nothing; wait for the other, then run `status`.                                                                            |
| `state.json is unreadable`, `compose.env is missing` | `down` and `destroy` refuse. Follow the printed steps: remove the project's containers, volumes, networks and images by exact name, then delete `.dev-infra` (`sudo rm -rf`). |
| `Timed out waiting for dokku`                        | Look at `dev:infra:logs`; the first start installs packages and can take minutes.                                                                                             |
| `router ... state exists`                            | A previous `up` stopped after `router init`: run `dev:infra:destroy`, then `up`.                                                                                              |
| `root helper container could not run`                | The pinned PostgreSQL image is missing or Docker refused; remove the named directories with the printed `sudo rm -rf` lines, then run `destroy` again.                        |

## Limits

- Linux with native Docker only, as `local:deploy`.
- The dashboard and deployments do not both work at once (see [Two presets](#two-presets)).
- One infrastructure per checkout; a second checkout gets another project name and the same default
  ports, so set the `DEV_*_PORT` variables for it.
- Nothing here backs up the database.
