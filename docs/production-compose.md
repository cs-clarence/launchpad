# Production Compose stack

For an operator preparing a single-host Launchpad installation with
[`docker-compose.yaml`](../docker-compose.yaml). **This configuration has
been rehearsed on disposable infrastructure, never started as production.**
The [first run](plans/evidence/p7-compose-20261121/README.md) used deployments on
and aliases off. [Later runs](plans/deployment-p7-acceptance.md#aliases-on-compose-rehearsal-2026-11-22)
verified aliases, private router-control TLS, certificate rotation and recovery.
Its shape is checked by `omni -i run check:compose`; see
[What is NOT production-ready](#what-is-not-production-ready) for the remaining gates.
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
   domain** ([access](access.md)) when preparing an actual installation.
   The [disposable ingress example](ingress-example.md) verifies the contract
   without a real domain, gateway, or DNS change.
2. Create, as host directories you own: Dokku state (`DOKKU_DATA_DIR`) and the backup
   directory (`LAUNCHPAD_BACKUP_DIR`, owned by `10001:10001`, outside every cleanup
   target). Use absolute physical paths: Dokku's host-path settings are derived from
   `DOKKU_DATA_DIR` and must equal what the host engine sees. Only chown a directory
   you just created; never recursively on an existing user path.
   The root of the new Dokku state bind must be traversable by Dokku's
   unprivileged user inside the container. Use mode `0755` for that new mount
   root, not `0700`: Dokku cannot create `/home/dokku/VHOST` otherwise. Keep
   credentials outside this directory with their own restrictive modes.
3. Copy `docker-compose.env.example` to `docker-compose.env` (ignored by
   Git) and replace every placeholder. Generate secrets through your secret workflow,
   never in chat or Git; use only URL-safe characters in `POSTGRES_PASSWORD` (it is
   embedded in `DATABASE_URL`). `DOCKER_SOCKET_GID` is `stat -c %g /var/run/docker.sock`.
4. Create the SSH key pair for the worker, and later the pinned `known_hosts` (see below),
   and the router token (64 lowercase hex characters) and epoch files. The worker
   requires the token file to be a regular file owned by 10001 with mode 0600; because
   these are bind mounts, set that ownership on the host files
   ([install](install.md), step 6).
   Provision the router's certificate, private key and public CA bundle per
   [router control certificates](#router-control-certificates). These files are
   required to start the router even when aliases are off.
5. Render without starting anything:

    ```sh
    docker compose --env-file docker-compose.env -f docker-compose.yaml --profile admin config --quiet
    ```

    For a disposable rehearsal, also run `omni -i run check:compose:rehearsal`.
    Check both Compose and Buildx versions before building. See the
    [tested combination](plans/production-fresh-host-recovery.md#repeat-the-rehearsal);
    older Compose versions can fail the mount checks.

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
   agree). Keep `LAUNCHPAD_ALIASES=off` until you verify private `https://router:3081`
   with your own certificates and intended routing, and complete the remaining
   cutover checks for your installation. The disposable rehearsal used a fixture CA.

Never use `compose down -v` or `docker volume rm` against this project without an exact,
reviewed target list: the volumes hold the database, the archives and the router state.

## Router control certificates

For the operator owning issuance, renewal and rotation. Before first start,
obtain an unexpired PEM server certificate with **DNS SAN `router`** and
server-auth usage, signed by your private CA. `LAUNCHPAD_ROUTER_TLS_CERT_FILE`
names its certificate chain (leaf then intermediates); `LAUNCHPAD_ROUTER_TLS_KEY_FILE`
names its matching, unencrypted PEM key. The key must be a regular file, not a
symlink, mode 0600 and owned by uid 10001. The certificate and the public issuing
CA bundle (`LAUNCHPAD_ROUTER_TLS_CA_FILE`) must be readable by uid 10001.
Use dedicated files and preserve private permissions; never recursively change
ownership on existing user directories.

Compose mounts server certificate/key only into the router. The public CA bundle
goes only to worker, admin and the router's own health client, not controller,
PostgreSQL, Dokku or app containers. The CA **private key stays offline/outside
the stack**. Each control client trusts that bundle only for router-control
requests, with hostname verification still enabled; there is no global TLS
override or plaintext fallback. The router health client dials the configured
listener locally and verifies its certificate for `router`. Neither control port 3081
nor CA credentials are published. Data port 3080 remains separate HTTP.

Before expiration, issue a new matching certificate/key for the same SAN.
Quiesce alias mutation dispatch and wait for in-flight promotions to settle; if
an outcome is uncertain, preserve its pins and use the reconciliation procedure
instead of retrying. Replace only the approved certificate files, retain a
private rollback copy of the old still-valid pair, then recreate the router
(`docker compose ... up -d --force-recreate router`). Recreating is important:
replacing a host file atomically does not update an existing file bind mount.
Require healthy verified TLS and authenticated admin route readback before
resuming dispatch. Certificate/key are loaded at router startup, not hot-reloaded.

For a CA change, first deploy a bundle containing both old and new public CAs
and recreate worker, admin invocations and router so all file binds see it.
Then change the server certificate/key and recreate the router. Verify control
readback before resuming. Only after all clients have switched, remove the old
CA and recreate affected services again. Keep old/new materials private until
rollback is no longer needed. Monitor expiration externally; there is no
automatic issuer, renewal or certificate-expiry alarm.

Certificate-only rotation must not run `router init` or `rotate`, delete routing
state, change tokens/epochs, or release deployment pins. If verification fails,
leave mutations quiescent and restore the still-valid certificate/trust
configuration; never bypass verification or revert to HTTP on the bridge.
Public app and management ingress TLS are separate and remain unconfigured.

## Stopping and restarting the worker

Stop the worker only when no deployment, promotion or deletion is in flight. Check with the
authenticated API (`GET /api/v1/status` and the deployment list) before `docker compose stop worker`.

If it is stopped mid-run, the process ends that run as `authority-lost` immediately (the 25-minute
`stop_grace_period` only bounds how long Docker waits before killing the container; the worker does
not use it to finish the work). The Dokku or Docker step it dispatched may still be running on the
host. The deployment stays in its step until its lease expires (about 170 s in the 2026-11-21
rehearsal) and is then held as `reconciliation-needed`. Recovery is an operator action: wait for the
host to settle, then run `deployment-reconcile` (see [deployments](deployments.md)); do not retry by
hand. Restarting the worker does not resume a held operation by itself.

Do not shorten the **restore** waits on the strength of this: after a restore the 25-minute minimum
in [restore](restore.md) is a conservative bound on every dispatched call, not a statement that
workers drain. Whether to implement a real drain on shutdown is an open product decision; until it
is made, this stop-and-reconcile behavior is the supported one.

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

For separate Dokku and router-state copies, stop and settle the writers, stop
Dokku and the router, and take private offline archives that preserve numeric
owners and permissions. Store their checksums separately and verify extraction
into fresh destinations before any replacement. Treat the archives as secrets:
Dokku state includes SSH host keys. Keep the source state offline while testing
the replacement; never run two authorities for the same fixture.

The [disposable state drill](plans/production-state-backup-rehearsal.md#result-2026-11-23)
verified a same-host restore using the existing Docker apps network, images and
containers. It does not recover those resources after host loss. Check served
deployment identities as well as container health. Do not roll back router
state under a live database; follow the [recovery procedure](restore.md) for
generation and epoch handling.

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

The app base (`LAUNCHPAD_BASE_IMAGE`) defaults, in this file, to
`nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10`
(the index digest read with `docker buildx imagetools inspect nginx:1.27-alpine` on 2026-11-23;
`check:compose` fails if the default is not a tag plus digest). The worker passes the
reference to Docker unchanged. To change it, read and verify the new digest the same way,
set both the tag and digest, and rebuild; existing deployments keep the image they were
built from. The worker's own code default stays the bare tag, which matters only when it
runs outside this file. nginx 1.27 is an older mainline line: moving to a supported
version is a separate, deliberate change to the tag and digest together.

**OS packages are not pinned.** The admin image's PostgreSQL client tools and Dokku's first
start install the distribution's current packages, so two builds can differ. This is an
accepted, documented gap: record the resulting `pg_dump --version` and `dokku version`
with each release, and prefer rebuilding the admin image when you restore so the client is
at least as new as the server. Pinning them would need a mirrored package snapshot, which
this repository does not operate.

## Resource limits

Set from one rehearsal ([evidence](plans/evidence/p7-compose-20261121/README.md), `docker stats`
every 2 s during an idle period and two fixture deploys), deliberately several times the peaks
seen. They are not capacity planning: Docker builds and Dokku's `docker` commands run in the
**host engine**, outside these cgroups.

| Service    | `mem_limit` | `cpus` | `pids_limit` | Idle / peak memory seen           | Peak CPU seen |
| ---------- | ----------- | ------ | ------------ | --------------------------------- | ------------- |
| postgres   | 512m        | 1.0    | 256          | 53 / 62 MiB                       | 22 %          |
| controller | 512m        | 1.0    | 256          | 49 / 56 MiB                       | 12 %          |
| worker     | 1g          | 1.0    | 256          | 23 / 433 MiB (two runs: 421, 433) | 97 %          |
| dokku      | 1g          | 2.0    | 1024         | 22 / 74 MiB                       | 171 %         |
| router     | 128m        | 0.5    | 128          | 11 / 15 MiB                       | 12 %          |
| admin      | 512m        | 1.0    | 256          | not measured                      | not measured  |

The stack ran with these limits through a second deploy and delete with no OOM kill and no
restart. The worker limit was raised from 512m to 1g after the measurement below. Nothing was
killed: the worker reached 421 MiB and 433 MiB (two runs) while building the largest archive the
default limits allow, which is about 85 % of the old limit, so the larger limit is a margin chosen
on that evidence, not a fix for an observed failure.

### Measured at the default limits (2026-11-23)

One disposable run on one small host (`LAUNCHPAD_COMPOSE_CAPACITY=1 omni -i run
test:compose:rehearsal`, with the read-only filesystems below), sampled with `docker stats` about
every 2 s, so brief peaks can be missed. It shows how the shipped limits behave here; it is not a
capacity guarantee.

| Deploy of one archive                                     | Upload | Deploy to `succeeded` | Worker peak memory | Dokku peak CPU |
| --------------------------------------------------------- | ------ | --------------------- | ------------------ | -------------- |
| Small site                                                | 0 s    | 66 s                  | 35 MiB             | 154 %          |
| 44 MiB, incompressible (limit 50 MiB upload)              | 0.4 s  | 66 s                  | 88 MiB             | 175 %          |
| 190 MiB expanded, 0.2 MiB upload (limit 200 MiB expanded) | 0.8 s  | 68 s                  | **421 MiB**        | 179 %          |
| 4,500 files (limit 5,000)                                 | 0.3 s  | 68 s                  | 103 MiB            | 175 %          |

- A deploy takes about a minute whatever its size; the archive size mostly moves worker memory.
- **Five concurrent deployments (the default app quota) took 308 s in total.** The worker handles
  deployments one after another, so concurrency adds latency rather than throughput. That is
  inferred from the total (about 5 x 62 s), not observed directly. Dokku's single-sample peaks
  were 211 % CPU and 317 processes, so do not lower its `cpus` or `pids_limit` on this evidence.
- `backup` and `verify-backup` of every fixture archive and row took 2.5 s (a few dozen MiB of
  archives and a small database). Restore and a large database were not measured.
- Still not measured: Dokku's first-start installation on this build, many apps beyond the quota,
  limits raised above the defaults, host reboot, database loss. Docker builds run in the host
  engine outside these cgroups.

The measurement found and led to fixing one defect: a site that compresses beyond 1000:1 (for
example a large run of zeros) was accepted at upload but failed at build with an opaque
`step-failed`, because the extractor had its own ratio guard. The worker now relies on the
expanded-size limit that was already enforced.

## Hardening

Assessed 2026-11-23; each item is adopted or deferred with its reason.

| Item                                                               | Decision                                    | Reason and evidence                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only root filesystem for controller, worker, router and admin | **Adopted** (with a 64 MiB tmpfs at `/tmp`) | The full alias baseline passed with it, and so did uploads and builds up to the default limits: all state lives in volumes and the worker's build scratch is under `/data`, not `/tmp`. `check:compose` enforces it.                                                                                                                                        |
| Read-only root filesystem for PostgreSQL and Dokku                 | Deferred                                    | Dokku installs packages on first start and writes across `/etc` and `/var`; PostgreSQL would need its own tmpfs paths. Neither was tested, and `check:compose` fails if either is switched on unverified.                                                                                                                                                   |
| Database password in a file instead of `DATABASE_URL`              | Deferred                                    | The controller, worker and admin read the URL only from the environment, so a file would be a code change in all three. Whoever can `docker inspect` the stack already holds the root-equivalent Docker socket the worker and Dokku mount, so a file secret protects little in this single-host model. Keep `docker-compose.env` mode 0600 and outside Git. |
| SMTP                                                               | Not configured                              | Email is optional. Invitation enrollment needs it; with operator enrollment (the default here) it is not used, and account recovery uses `reset-password` on the host. Configure it, with a TLS-verifying server, only if invitations are wanted.                                                                                                           |
| Docker socket and single-host threat model                         | Needs your decision                         | Not changed: see [What is NOT production-ready](#what-is-not-production-ready).                                                                                                                                                                                                                                                                             |

## What is NOT production-ready

See the [tracked follow-ups](plans/production-compose-follow-up.md#outstanding-follow-ups-after-the-bundled-p7-pr)
for the remaining decisions and their verification criteria.

- **First rehearsal, on a disposable instance, with aliases off (2026-11-21).** The stack started in order and all
  five services became healthy; `cap_drop: ALL`, read-only credential mounts, the `apps` network,
  worker SSH to Dokku, one fixture deploy/probe/delete, backup, fresh-database restore with
  `check-restore`, and recreate-keeps-artifacts worked
  ([evidence](plans/evidence/p7-compose-20261121/README.md)). This is not a production claim.
- **Alias routing in Compose was rehearsed on disposable infrastructure.**
  The plaintext-control blocker is fixed: native HTTPS, per-client CA
  trust and read-only mounts. One aliases-on instance of this file started healthy,
  verified the CA over Compose DNS (untrusted, wrong-name and plaintext requests
  refused, port 3081 unpublished), then bound, promoted, reconciled a held promotion,
  withdrew and deleted, with exact-scope cleanup ([record](plans/deployment-p7-acceptance.md#aliases-on-compose-rehearsal-2026-11-22)).
  The [rotation procedure](#router-control-certificates) was also rehearsed there
  (certificate-only, then CA via an old+new bundle), and so was recovery: backup,
  restore into a fresh database, managed router rotation, the full 25-minute gate,
  republish, `recovery-clear` and a resumed promotion. Public ingress and the
  full S1–S14 matrix are not covered on this topology.
- **Dokku is not on the engine's default bridge.** Compose cannot attach a service to it (the engine
  rejects the aliases Compose sends), so app containers live on the `apps` network. Without the
  `initial-network` setting (kept in `DOKKU_DATA_DIR`) apps would land on the default bridge, where
  Dokku's proxy cannot reach them (not tested).
- **A stopped worker abandons its run.** Stopping the worker during a deploy ended the run
  `authority-lost` immediately, and the deployment became `reconciliation-needed` after the lease
  expired (about 170 s); the 25-minute grace did not make it finish. Stop the worker only when
  idle, or expect an operator `deployment-reconcile`.
- **Ingress TLS and domains are undecided.** Private router-control TLS does not
  terminate app or management HTTPS; every host
  binding is loopback. The management origin must be HTTPS and the apps domain a
  separate registrable domain before deployments can be enabled for real users.
  The [disposable ingress example](ingress-example.md) verifies the routing and isolation
  contract with synthetic hostnames; it is not a production configuration.
- **One host, one engine.** The worker and Dokku share the host's Docker engine.
  Access to its socket is root-equivalent on that host; the stack gives no isolation
  from hostile uploaded sites beyond Dokku's own.
- **Resource limits come from the [2026-11-23 measurements](#measured-at-the-default-limits-2026-11-23).**
  Database loss, worker liveness and load beyond the default 10-app quota are not rehearsed.
- **Whole-host recovery passed on disposable QEMU/KVM guests.** The `backup` command
  does not include Dokku or router state or the container images. The
  [clean-host rehearsal](plans/production-fresh-host-recovery.md#result-2026-11-23)
  recovered those separately, verified the app and alias routes, revoked restored
  credentials, and resumed writes only after the recovery gate. A separate
  [clean install and orderly reboot](plans/production-compose-install-reboot.md#result-2026-11-23)
  passed under the normal restart policies. [Runtime upgrade and rollback](plans/production-compose-rehearsal.md#runtime-upgrade-and-rollback-result-2026-11-23)
  passed across two revisions with no migration delta; schema rollback remains
  untested on this topology.
- **PostgreSQL client TLS options** have an
  [explicit translation/refusal contract](backup.md#database-connection-options), unit-tested
  and [verified with a disposable TLS-required PostgreSQL 17 server](plans/production-pg-client-options.md#disposable-postgresql-tls-drill-2026-11-23).
  The bundled Compose PostgreSQL service is still private-network-only, not configured for TLS.
- **No SMTP or secrets manager by default.** The database URL (with
  its password) is a container environment variable visible to anyone who can inspect
  containers.
- **Cleanup of the old demo/test resources has not been executed** and is separate.
- **Worker identity.** `LAUNCHPAD_WORKER_ID` (1 to 64 characters: letters, digits, `.`, `_`, `-`) names
  the worker in `lease_owner` and in its `deployment-worker-started` log line; unset or empty keeps a new
  random identity per process. It identifies only. Claims are fenced by an attempt and a fence counter that
  every claim advances, not by the name, and work is reclaimed only after its lease expires, so a stable
  name neither speeds up recovery nor lets a stale process write. Give each worker its own name:
  two workers sharing one stay safe but become indistinguishable in the database and logs.
