# Deploy a site on your machine

For a developer who wants to see the whole system work once: a controller, a worker, Dokku and the
router in Docker, the `hello` example deployed with the `launchpad` CLI, and one command that removes
everything the run created. It extends [run Launchpad on your machine](local-quickstart.md), which
runs only the controller and deploys nothing, and uses the stack described in
[production Compose](production-compose.md).

## Read this first

- This mounts the host Docker socket into the worker and into Dokku. That is **root-equivalent on
  your machine**. Run it only on a machine you would trust with that, never on a shared or production
  host, and deploy only sites you trust.
- Everything binds `127.0.0.1` and must stay that way. The tool has no option to change it.
- Dokku's first start installs unpinned packages from the internet (accepted for production Compose too).
- The generated keys and passwords live in `.local-deploy/` in the checkout and, for the accounts, in
  your CLI configuration directory. Treat them as secrets; do not commit or share them.
- `down` deletes the database, every deployment and the key files.
- The dashboard does not work in this setup (see [Limits](#limits)).
- This is not a production install and not a way to try public exposure.

You need Linux with native Docker Engine and Docker Compose v2 (not Docker Desktop, rootless Docker,
Podman or a remote `DOCKER_HOST`), [Bun](https://bun.sh) 1.4.4, [Omni](https://github.com/omni-oss/omni),
`openssl`, `ssh-keygen` and `tar`, and a checkout of this repository. Run every command from the
repository root.

## What it costs

| What                                    | Measured                                                                                                                                                                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory limits of the five services      | 0.5 + 0.5 + 1 + 1 + 0.125 GiB, about 3.1 GiB (3.6 GiB while the admin container runs)                                                                                                                                                                                      |
| Idle memory (measured)                  | about 175 MiB with one deployed site (PostgreSQL 61, controller 52, Dokku 26, worker 25, router 11 MiB)                                                                                                                                                                    |
| First `up` (warm caches, measured)      | 72 s with warm Docker layer and base-image caches (Dokku healthy after about a minute). A cold first run was not measured; earlier rehearsals saw 4.5 minutes for Dokku's first start alone, so allow 10 to 20 minutes (a guess)                                           |
| `up` again with warm layers (measured)  | 51 to 55 s (images rebuilt from cache, services re-checked, nothing re-seeded)                                                                                                                                                                                             |
| One deployment of `hello` (measured)    | 53 to 59 s from `app deploy` to `succeeded`                                                                                                                                                                                                                                |
| Disk (images and build cache, measured) | the five images are about 2.4 GB (Dokku 1.53 GB, worker 242 MB, controller 212 MB, admin 269 MB, router 190 MB), removed by `down`; the build cache grew by about 1.2 GB over the runs and stays, as do a few superseded layers (docker builder prune, docker image prune) |

Builds and deployed sites run in the host engine, outside the memory limits.

## Set it up

1. Install the dependencies and the agent context:

    ```sh
    bun install --frozen-lockfile
    omni remote-sources install && omni projection sync
    ```

2. Start everything:

    ```sh
    omni -i run local:deploy -a options=up
    ```

    It checks Docker, that `.local-deploy/` is ignored by git and that the ports are free, writes
    `.local-deploy/` (mode 700) with its record first, builds the images under tags of its own
    (`launchpad-local-<hash>/<service>:local`), starts PostgreSQL and Dokku, pins Dokku's host key and
    registers the worker's key, initialises the router, migrates the database, starts the rest,
    and creates an organization `local`, a project `demo` and a 90-day key with six scopes saved as the
    CLI profile `local-deploy`. It prints the ports and the next step, never a secret. It is safe to
    run again: it keeps what exists. If a default port (32180 to 32443) is busy it stops and names
    it; choose another range with `--port-base <n>`. `omni -i run local:deploy -a options=--help`
    lists everything. If a saved `local-deploy` key lacks the scopes deploying needs, `up` refuses and
    names them; run `up --new-key` to issue a replacement. `up --new-key` also replaces a saved key of
    this same controller that was revoked or expired. A profile that points at a different controller
    (a stack removed by hand and recreated on other ports) is never replaced by `up`: run
    `launchpad logout` first. With `LAUNCHPAD_ALIASES=on` in `.local-deploy/compose.env`, the key has
    eight scopes (the six plus `app:promote` and `app:alias:manage`).

3. Build the CLI once and deploy the example. The profile is on loopback `http`, so no certificate is
   needed:

    ```sh
    omni -i run build -p @launchpad-kit/cli
    alias launchpad="bun $PWD/apps/cli/dist/index.js"
    export LAUNCHPAD_PROFILE=local-deploy
    PROJECT=$(launchpad api organizations/{org}/projects | grep -m1 '"id"' | cut -d'"' -f4)
    ARTIFACT=$(launchpad artifact upload "$PROJECT" examples/hello --directory | grep -m1 '"id"' | cut -d'"' -f4)
    APP=$(launchpad app create "$PROJECT" hello | grep -m1 '"id"' | cut -d'"' -f4)
    DEPLOYMENT=$(launchpad app deploy "$APP" --artifact "$ARTIFACT" | grep -m1 '"id"' | cut -d'"' -f4)
    ```

4. Wait for it. This stops on any final state, prints the events when it did not succeed and gives up
   after ten minutes (the deployment may still be running):

    ```sh
    for i in $(seq 1 200); do
      STATUS=$(launchpad deployment get "$DEPLOYMENT" | grep -m1 '"status"' | cut -d'"' -f4)
      case "$STATUS" in
        succeeded) break ;;
        failed|cancelled|reconciliation-needed) launchpad deployment events "$DEPLOYMENT"; break ;;
      esac
      sleep 3
    done
    echo "$STATUS"
    ```

    A deployment that ends `reconciliation-needed` is explained in
    [deployments](deployments.md#when-the-worker-cannot-confirm-something); `down` removes it anyway. If
    it fails, `docker compose -p <project> --env-file .local-deploy/compose.env -f docker-compose.yaml -f .local-deploy/override.json logs --tail 50 worker` shows why.

5. Look at the site. The deployment's `hostname` is in its `get` output
   (`hello-<10 characters>-preview.apps.localhost`), and Dokku's HTTP port is on loopback (the HTTP port `up` printed;
   32181 by default). Send the host name yourself, which works everywhere:

    ```sh
    HOSTNAME_=$(launchpad deployment get "$DEPLOYMENT" | grep -m1 '"hostname"' | cut -d'"' -f4)
    HTTP_PORT=32181   # the Dokku HTTP port that `up` printed
    curl -H "Host: $HOSTNAME_" "http://127.0.0.1:$HTTP_PORT/"
    ```

    Current browsers and curl 7.78 or later also resolve `*.localhost` to loopback, so
    `http://<hostname>:<http-port>/` can work. Some resolvers send `*.localhost` to `::1` first, where nothing
    listens (Docker publishes `127.0.0.1` only), or do not map it at all. Then use the `Host`
    form above, or add `127.0.0.1 <hostname>` to `/etc/hosts` (needs root).

6. Check or stop it:

    ```sh
    omni -i run local:deploy -a options=status
    docker compose -p <project> --env-file .local-deploy/compose.env -f docker-compose.yaml -f .local-deploy/override.json stop
    ```

    `status` prints each service's health, the ports and the profile, and refreshes the recorded
    list of deployments. `stop` keeps everything; `up` starts it again. `<project>` is the name `up`
    printed (`launchpad-local-` and eight hex characters taken from the checkout's path, so two
    checkouts never collide); run the command from the repository root, because the paths are relative to it.

7. Remove everything:

    ```sh
    omni -i run local:deploy -a options=down
    ```

## What it does to your CLI profiles

`up` saves a profile `local-deploy` and never switches your current profile, except when you have none:
then it becomes current and `up` records that in `.local-deploy/state.json`. The guide selects the profile
per shell with `LAUNCHPAD_PROFILE` (or use `--profile local-deploy` on a command). `down` deletes the
`local-deploy` profile, and resets the current profile only if `up` had set it and it still points at
`local-deploy`, in which case none is current afterwards (none was before `up`). If you made `local-deploy`
current yourself, `down` makes the first remaining profile current instead of leaving a deleted name; if
another profile is current it is left alone.

## What `down` removes, and what stays

`down` can be interrupted and run again (an interrupt is honoured between sites and between phases; the operation in progress finishes). It stops the controller and worker, waits for Dokku to be idle,
finds the deployed sites (from the database, the recorded list, Dokku and the project's apps network),
destroys their Dokku apps and removes their containers and images directly (it never calls the API),
removes the project's containers, volumes and networks, clears the root-owned Dokku state with a
short-lived helper container, removes the five images it built, deletes the CLI profile and checks that nothing
is left. Only then does it delete `.local-deploy/`. Every name it removes comes from this project's own
labels and validated records; it never uses a wildcard, a prefix or `prune`.

Pulled images (PostgreSQL, nginx, the Bun and Dokku bases), dangling layers and the build cache stay;
remove them with `docker image prune` and `docker builder prune` if you want the disk back. The two
password files in your CLI configuration directory (`local-deploy-operator.password` and
`local-deploy-owner.password`) also stay; they hold the passwords of accounts that no longer exist.

If it cannot proceed it says why and keeps `.local-deploy/`. If the Docker daemon is stopped, start it. If
Dokku is stopped, run `docker compose -p <project> --env-file .local-deploy/compose.env -f docker-compose.yaml -f .local-deploy/override.json start dokku postgres`. If the helper cannot run it
prints the exact `sudo rm -rf` command for each root-owned directory. If an image tag could not be worked out
(the database was unreachable and no `status` had recorded the deployment), it says so and names
`docker image ls launchpad/site`. The by-hand fallback is `docker compose -p <project> --env-file .local-deploy/compose.env -f docker-compose.yaml -f .local-deploy/override.json exec dokku dokku apps:list`, then the same command with `exec dokku dokku apps:destroy <name> --force`, and `docker image rm launchpad/site:<id>` for each
`lp-` app you recognise.

## If it fails

Each failure prints one message and exits nonzero; nothing is rolled back and `down` removes whatever exists.

| Message starts with                                                  | What to do                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `The Docker daemon did not answer`                                   | Start Docker, or check that you may use it.                                                                                                                                                                                                                                                                    |
| `DOCKER_HOST is set`                                                 | Unset it: only the local engine at `/var/run/docker.sock` works.                                                                                                                                                                                                                                               |
| `... is in use on 127.0.0.1`                                         | Free the port, or run `up` with `--port-base <n>`.                                                                                                                                                                                                                                                             |
| `... is not ignored by git`                                          | `.local-deploy/` must be in `.gitignore`.                                                                                                                                                                                                                                                                      |
| `Timed out waiting for dokku`                                        | Look at `docker compose -p <project> --env-file .local-deploy/compose.env -f docker-compose.yaml -f .local-deploy/override.json logs --tail 50 dokku`; Dokku's first start takes minutes.                                                                                                                      |
| `... has no matching state.json`                                     | Another checkout or an earlier run owns those resources; run `down` from there.                                                                                                                                                                                                                                |
| `The profile "local-deploy" already exists and is not a working key` | The saved key was revoked (for example by `revoke-all-credentials`): run `up --new-key`. If it points at a different controller or organization (a stack you removed by hand), run `launchpad logout` first (with `LAUNCHPAD_PROFILE=local-deploy` set), then `up --new-key`; `--force` is not an `up` option. |
| `Compose ... Buildx`                                                 | See the [recovery record](plans/production-fresh-host-recovery.md#repeat-the-rehearsal).                                                                                                                                                                                                                       |

## Limits

- **The dashboard does not work.** With an apps domain set the controller requires an `https` base URL,
  and a browser session needs the cookie origin to equal it with `Secure` cookies; the dashboard's
  preview link is `https://<hostname>` without a port, which cannot reach an unprivileged loopback port.
  The tool sets the base URL to `https://control.localhost:8443`, where nothing listens, so that the
  controller starts; the CLI and API use `http://127.0.0.1:<port>` because they send no cookie origin.
  A dashboard through a proxy with a local certificate is a follow-up (see the
  [ingress example](ingress-example.md)).
- Aliases are off (`LAUNCHPAD_ALIASES=off`); the router only has to be running.
  To try aliases, set `LAUNCHPAD_ALIASES=on` in `.local-deploy/compose.env` and recreate the controller and worker
  (`up` keeps the value). When `compose.env` says `on` at the time of `up`, the key `up` issues also has
  `app:promote` and `app:alias:manage`. A key saved before you switched has only the six, so run
  `up --new-key` after flipping the setting.
- Linux with native Docker only; one worker; no backups or restores.
