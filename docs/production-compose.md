# Production Compose stack

For an operator preparing a single-host Launchpad installation with
[`docker-compose.yaml`](../docker-compose.yaml). **This is prepared
configuration. It has been started once, by hand, on disposable infrastructure
(2026-11-21, [evidence](plans/evidence/p7-compose-20261121/README.md)) with
deployments on and aliases off; it has never been started as production.** Its
shape is checked by `omni -i run check:compose`. The rehearsal fixed four
configuration defects and found one blocker: **`LAUNCHPAD_ALIASES=on` does not work
with this file** (see [What is NOT production-ready](#what-is-not-production-ready)).
Targeting `dokku` starts only that service, but Compose still requires the full
environment to render the file. This is not an in-place migration from the old
Dokku-only file: the project and default ports changed, and existing Dokku data
is not adopted automatically. Leave legacy state in place pending a separate cutover.

## What it defines

| Service      | Role                                                                                                         | Published (loopback by default)              |
| ------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `postgres`   | PostgreSQL 17 on the private `database` network (`internal: true`)                                           | nothing                                      |
| `controller` | Management UI and API                                                                                        | 32180 → 3000                                 |
| `worker`     | Deployment worker; holds the Docker socket and the Dokku SSH key                                             | nothing                                      |
| `dokku`      | `containers/dokku` image; holds the Docker socket; state bind-mounted from the host; on `backend` and `apps` | SSH 32222 → 22, HTTP 32181 → 80, 32443 → 443 |
| `router`     | The alias router (`apps/router`); control plane (3081) is never published                                    | data plane 32182 → 3080                      |
| `admin`      | One-off operator commands; profile `admin`, no restart policy                                                | nothing                                      |

Properties the file keeps (asserted by `tooling/compose-production.ts`): explicit
project name `launchpad-production`; no `env_file` and no fixed `container_name`;
each service receives only its own allowlisted `environment`; every secret is a
required `${VAR:?}` (an unset one makes Compose refuse to render); the controller,
worker and admin share one `launchpad-data` volume at `/data` and the same archive
limits, switches and quotas (one YAML anchor); the worker has
`stop_grace_period: 25m` (not a drain guarantee) and the
Docker socket's group; credential files are mounted read-only and host binds are
never auto-created; logs rotate (10 MB × 5); every long-running service has a
healthcheck and `restart: unless-stopped`; every service has `mem_limit`, `cpus` and
`pids_limit` ([measured](#resource-limits)); external base images are pinned by digest
([images](#images-and-pins)).

Safe defaults: `LAUNCHPAD_DEPLOYMENTS=off`, `LAUNCHPAD_ALIASES=off`,
`LAUNCHPAD_PUBLIC_SIGNUP=false`, `LAUNCHPAD_ENROLLMENT=operator`,
`LAUNCHPAD_API_DOCS=false`, `LAUNCHPAD_TRUSTED_PROXY=false`. Settings use the
current names (`LAUNCHPAD_APPS_DOMAIN`, `LAUNCHPAD_APPS_PROXY_URL`, `LAUNCHPAD_ALIAS_*`).

Check that no port is occupied before use; never stop whatever owns a port.

## Prepare

1. Choose an exact management origin and an apps domain on a **different registrable
   domain** ([access](access.md)). Domains, TLS and ingress are not decided here.
2. Create, as host directories you own: Dokku state (`DOKKU_DATA_DIR`) and the backup
   directory (`LAUNCHPAD_BACKUP_DIR`, owned by `10001:10001`, outside every cleanup
   target). Use absolute physical paths: Dokku's host-path settings are derived from
   `DOKKU_DATA_DIR` and must equal what the host engine sees. Only chown a directory
   you just created; never recursively on an existing user path.
3. Copy `docker-compose.env.example` to `docker-compose.env` (ignored by
   Git) and replace every placeholder. Generate secrets through your secret workflow,
   never in chat or Git; use only URL-safe characters in `POSTGRES_PASSWORD` (it is
   embedded in `DATABASE_URL`). `DOCKER_SOCKET_GID` is `stat -c %g /var/run/docker.sock`.
4. Create the SSH key pair for the worker, and later the pinned `known_hosts` (see below),
   and the router token (64 lowercase hex characters) and epoch files. The worker
   requires the token file to be a regular file owned by 10001 with mode 0600; because
   these are bind mounts, set that ownership on the host files
   ([install](install.md), step 6).
5. Render without starting anything:

    ```sh
    docker compose --env-file docker-compose.env -f docker-compose.yaml --profile admin config --quiet
    ```

## Build

From the repository root, with BuildKit. These are local tags; nothing is pushed:

```sh
export LAUNCHPAD_VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' package.json | head -n 1)"
docker compose --env-file docker-compose.env -f docker-compose.yaml --profile admin build
```

## First start, in order

Each step is a deliberate operator action. `up` never starts `admin`.

1. Start the database and Dokku only:
   `docker compose --env-file docker-compose.env -f docker-compose.yaml up -d postgres dokku`.
2. Wait for `dokku` to be `healthy`: its first start (an empty `DOKKU_DATA_DIR`) installs
   packages and took about 4.5 minutes, a later start about one minute (the healthcheck
   requires the HTTP proxy to listen). Tell Dokku to put app containers on the `apps`
   network (Compose cannot attach it to the default bridge): `docker compose ... exec -T dokku
   dokku network:set --global initial-network <LAUNCHPAD_APPS_NETWORK>` (default
   `launchpad-apps`; the network's name has no project prefix). Then read Dokku's host key out of band and write the pinned `known_hosts` entry for the
   host `dokku` port 22; register the worker's **public** key with
   `docker compose ... exec -T dokku dokku ssh-keys:add launchpad-worker < key.pub`.
3. Migrate, then confirm: `docker compose ... run --rm admin migrate`, then
   `... run --rm admin migrate --status` (`pending: 0`).
4. Create the first operator:
   `... run --rm admin setup --email <address> --password-file <mode-0600 file>`. The
   password file must be mode 0600 **and owned by uid 10001** (the command refuses
   otherwise; a bind-mounted file keeps its host owner, so create it as root or chown it once).
   Mount it only into that one invocation, e.g. with `-v`.
5. Initialize the router state once with the token on standard input:
   `... run --rm -T router init --token-stdin`; it prints the **epoch** (not a secret).
   Write it to the epoch file. The router refuses to serve without state, and the worker
   waits for a healthy router. Compose prints its own status lines on standard error; the
   epoch is the one line on standard output.
6. Start everything else: `... up -d`. Verify `/api/health` on `127.0.0.1:32180` and
   the signed-in `GET /api/v1/status`.
7. Leave `LAUNCHPAD_DEPLOYMENTS` off until private routing and a
   [backup/restore rehearsal](restore.md) have passed; then enable deployments in
   `docker-compose.env` and recreate the controller and worker **together** (they must
   agree). **Keep `LAUNCHPAD_ALIASES=off`:** the worker
   and controller then refuse to start, because `LAUNCHPAD_ALIAS_CONTROL_URL` must be HTTPS or
   `http://127.0.0.1` and this file points it at `http://router:3081`.

Never use `compose down -v` or `docker volume rm` against this project without an exact,
reviewed target list: the volumes hold the database, the archives and the router state.

## Backup

Matched database and archive backups use the admin service, which carries PostgreSQL 17
client tools. Stop the writers you need to quiesce per [backup](backup.md), then:

```sh
docker compose --env-file docker-compose.env -f docker-compose.yaml \
  run --rm admin backup /backups/launchpad-<date>
docker compose ... run --rm admin verify-backup /backups/launchpad-<date>
```

Copy the whole directory to private storage. Restore and its recovery steps are in
[restore](restore.md); preserve its full remote-settling wait. The backup does **not**
cover Dokku state (`DOKKU_DATA_DIR`) or the router state volume.

## Images and pins

Base images are pinned by tag **and** index digest; `check:compose` fails on an unpinned
`FROM`, a malformed digest, a Dokku plugin that is not a 40-hex commit, or an unpinned
`postgres`. Digests were read on 2026-11-21 with `docker buildx imagetools inspect <image>`
(the manifest-list digest):

| Image                 | Digest                                                                    | Used by                                    |
| --------------------- | ------------------------------------------------------------------------- | ------------------------------------------ |
| `oven/bun:1.4.4`      | `sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d` | build stages of controller, worker, router |
| `oven/bun:1.4.4-slim` | `sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4` | runtime stages                             |
| `docker:28-cli`       | `sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d` | the worker's `docker` client               |
| `postgres:17-alpine`  | `sha256:526f86d93c6ea08fd3f1fe5605650cacc781b2c6013169a0ad8f42c7d3d84f32` | `postgres` service (`POSTGRES_IMAGE`)      |
| `dokku/dokku:0.38.34` | `sha256:70c09c7f5badff1b0a7077fe899db269255a22aed08571f4da605bfcb50fd8a8` | `containers/dokku`                         |

`dokku-http-auth` is installed from upstream commit `9c3e2636eda583ac667fbdca2b565b3dd6e8107e`
(master, committed 2026-11-09, read with `git ls-remote https://github.com/dokku/dokku-http-auth.git`
on 2026-11-21; there is no release tag newer than 0.14.1). The build uses
`dokku plugin:install <url> --committish <commit>`, and the installed plugin reports that commit.
To change a pin, change the tag and its digest together (the Dockerfile `ARG`s; overriding only
`BUN_VERSION`, `DOCKER_CLI_VERSION` or `DOKKU_VERSION` makes the digest mismatch and the build fail
closed), review the upstream diff, and re-run `check:compose`.

The app base (`LAUNCHPAD_BASE_IMAGE`) defaults to the tag `nginx:1.27-alpine`.
For repeatable builds, set it to a trusted image pinned by SHA-256 digest. Use
`docker buildx imagetools inspect nginx:1.27-alpine` to obtain and verify the
manifest digest before adding it to the reference. The worker accepts digest and
tag-plus-digest references and passes the reference to Docker unchanged. The
disposable Compose rehearsal used the tag, not a digest pin. The Debian/Ubuntu
packages the admin image and Dokku's first start install are not pinned.

## Resource limits

Set from one rehearsal ([evidence](plans/evidence/p7-compose-20261121/README.md), `docker stats`
every 2 s during an idle period and two fixture deploys), deliberately several times the peaks
seen. They are not capacity planning: Docker builds and Dokku's `docker` commands run in the
**host engine**, outside these cgroups.

| Service    | `mem_limit` | `cpus` | `pids_limit` | Idle / peak memory seen | Peak CPU seen |
| ---------- | ----------- | ------ | ------------ | ----------------------- | ------------- |
| postgres   | 512m        | 1.0    | 256          | 53 / 62 MiB             | 22 %          |
| controller | 512m        | 1.0    | 256          | 49 / 56 MiB             | 12 %          |
| worker     | 512m        | 1.0    | 256          | 23 / 39 MiB             | 26 %          |
| dokku      | 1g          | 2.0    | 1024         | 22 / 74 MiB             | 171 %         |
| router     | 128m        | 0.5    | 128          | 11 / 15 MiB             | 12 %          |
| admin      | 512m        | 1.0    | 256          | not measured            | not measured  |

The stack ran with these limits through a second deploy and delete with no OOM kill and no
restart. Not measured: large uploads and archive extraction, many apps, concurrent deployments,
backup or restore of a large database, Dokku's first-start installation. Revisit the limits with
those before relying on them.

## What is NOT production-ready

See the [tracked follow-ups](plans/production-compose-follow-up.md#outstanding-follow-ups-after-the-bundled-p7-pr)
for the remaining decisions and their verification criteria.

- **Proven once, on a disposable instance, with aliases off.** The stack started in order and all
  five services became healthy; `cap_drop: ALL`, read-only credential mounts, the `apps` network,
  worker SSH to Dokku, one fixture deploy/probe/delete, backup, fresh-database restore with
  `check-restore`, and recreate-keeps-artifacts worked
  ([evidence](plans/evidence/p7-compose-20261121/README.md)). This is not a production claim.
- **Alias routing is blocked.** `LAUNCHPAD_ALIASES=on` makes the worker and controller exit
  (`LAUNCHPAD_ALIAS_CONTROL_URL must be https, or http to 127.0.0.1 or [::1]`) because the router's
  control plane is plain HTTP on a private network. It needs a product/topology decision (TLS on the
  control plane, or a loopback path). The router's path after `init` was not exercised in this
  stack; the harness-based [acceptance run](plans/deployment-p7-acceptance.md) covers the router
  separately.
- **Dokku is not on the engine's default bridge.** Compose cannot attach a service to it (the engine
  rejects the aliases Compose sends), so app containers live on the `apps` network. Without the
  `initial-network` setting (kept in `DOKKU_DATA_DIR`) apps would land on the default bridge, where
  Dokku's proxy cannot reach them (not tested).
- **A stopped worker abandons its run.** Stopping the worker during a deploy ended the run
  `authority-lost` immediately, and the deployment became `reconciliation-needed` after the lease
  expired (about 170 s); the 25-minute grace did not make it finish. Stop the worker only when
  idle, or expect an operator `deployment-reconcile`.
- **TLS, ingress and domains are undecided.** Nothing terminates HTTPS; every host
  binding is loopback. The management origin must be HTTPS and the apps domain a
  separate registrable domain before deployments can be enabled for real users.
- **One host, one engine.** The worker and Dokku share the host's Docker engine.
  Access to its socket is root-equivalent on that host; the stack gives no isolation
  from hostile uploaded sites beyond Dokku's own.
- **Resource limits come from one small rehearsal** (above).
- **Backup of Dokku state and the router state volume** is not covered by `backup`; the
  TLS-option pass-through to the PostgreSQL clients and a credential-reset command remain
  slice 3. A restore followed by starting a controller and `recovery-clear` was not run here.
- **No SMTP, no read-only root filesystems, no secrets manager.** The database URL (with
  its password) is a container environment variable visible to anyone who can inspect
  containers.
- **Cleanup of the old demo/test resources has not been executed** and is separate.
- The worker has no setting for a stable worker id: its owner is a new UUID per process.
