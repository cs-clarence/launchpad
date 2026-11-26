# Install a private Launchpad instance from built artifacts

For an instance operator preparing a **private** Linux/amd64 installation. This
guide wires the artifacts and explains the checks. A Compose
definition, run once on disposable infrastructure and **never as production**, of the whole stack is described in [production Compose](production-compose.md);
neither it nor this guide supplies TLS ingress, a Dokku backup, or permission to expose
the controller publicly. Those are the [separate production follow-up](plans/production-compose-follow-up.md).

After enabling deployment and (optionally) alias routing, use the
[dashboard or CLI walkthrough](deployments.md#deploy-from-the-dashboard-or-cli)
to deploy to an immutable preview URL and separately choose whether to promote.

1. Provision one PostgreSQL database **owned by the runtime role**, a durable data
   volume, and a separate Dokku host. Use one Launchpad database and data directory
   per Dokku host. Provide a PostgreSQL client at least as new as the server for
   backups; `pg_dump`/`pg_restore` are not included in the controller image.
2. Build the images from the repository root with BuildKit:

    ```sh
    version="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' package.json | head -n 1)"
    [ -n "$version" ] || { echo "could not read the version from package.json" >&2; false; }
    docker build --build-arg LAUNCHPAD_VERSION="$version" -f apps/controller/Dockerfile -t launchpad/controller:local .
    docker build --build-arg LAUNCHPAD_VERSION="$version" -f apps/worker/Dockerfile -t launchpad/worker:local .
    docker build --target admin --build-arg LAUNCHPAD_VERSION="$version" -f apps/controller/Dockerfile -t launchpad/admin:local .
    ```

    The third image is the one-off **operator image**: the controller's program and user plus
    the PostgreSQL 17 client tools that `backup` and `restore` need. Run it with
    `docker run --rm --env DATABASE_URL ... launchpad/admin:local migrate --status`; it is never a service.
    The build argument records the version in backups and in the operator status; an image
    built without it reports `unknown`.

    These are local tags, not published images. Both images run as uid/gid 10001.
    Mount the **same** durable `/data` into both; a bind mount must be owned by
    10001:10001. Without an explicit mount, each gets a separate anonymous volume.
    See [tooling](tooling.md#configuration-and-containers) for image caveats.

    ```

    ```

3. Supply `DATABASE_URL`, `LAUNCHPAD_AUTH_SECRET` (at least 32 random characters),
   `LAUNCHPAD_BASE_URL` (the exact HTTPS origin used by browsers), and
   `LAUNCHPAD_DATA_DIR=/data` to the controller **at runtime**, never in an image.
   The directory must already be mounted/available; startup refuses missing storage.
   Readiness checks only that a plain directory exists, not that it is the intended
   shared volume. The image's anonymous `/data` volume also passes that check:
   verify the explicit mount and volume identity yourself.
   Keep the database and admin command private. Use
   [the controller settings reference](../apps/controller/README.md#configuration)
   for remaining values. The worker does not read database or Dokku settings while deployments are off.
   An enabled worker may be given a name with `LAUNCHPAD_WORKER_NAME` (the deprecated `LAUNCHPAD_WORKER_ID` still
   works); it is the worker's lease owner, its heartbeat key and what logs show. It is optional: the default is
   the hostname. Give each worker its own (see [production Compose](production-compose.md#health-readiness-and-worker-status)).
4. Run `bun .output/admin.mjs migrate --status` in the controller image with
   `DATABASE_URL` set. On a fresh database, a nonzero exit with pending migrations
   is expected. Run `bun .output/admin.mjs migrate` explicitly, then run
   `migrate --status` again; it must report `pending: 0` and exit 0. Neither process
   migrates on startup. The controller refuses an incompatible schema.
5. Start the controller with its private listener connected to the database and
   shared volume. Verify `/api/health` (liveness) and `/api/ready` (readiness: database and data directory), then sign in after running
   `bun .output/admin.mjs setup --email <operator-address> --password-file <mode-600-file>`
   in the controller image with the auth settings. The mode-`0600` password
   file must be readable by the admin process (the stock image runs as UID
   `10001`; a host-owned `0600` file with another UID will not work). The health endpoint reports
   static metadata, **not** database/Dokku readiness; use the signed-in
   operator-only `GET /api/v1/status` for runtime state.
6. Leave `LAUNCHPAD_DEPLOYMENTS=off` (the default) until private [routing](access.md)
   and a [backup/restore rehearsal](restore.md) have been checked. Keep the pinned
   Dokku settings and any router/proxy credentials available to the admin host for
   verified recovery. Off workers can
   stay stopped; they do not connect to PostgreSQL, Dokku or Docker. For an enabled
   worker set `LAUNCHPAD_DEPLOYMENTS=on`, the controller's `DATABASE_URL`,
   `LAUNCHPAD_DATA_DIR`, `LAUNCHPAD_BASE_URL`, `LAUNCHPAD_APPS_DOMAIN` and archive limits, and
   `LAUNCHPAD_APPS_PROXY_URL` (the HTTP or HTTPS origin of the Dokku proxy as seen
   by the worker). Set `DOKKU_SSH_HOST`, `DOKKU_SSH_KEY_PATH` and
   `DOKKU_SSH_KNOWN_HOSTS_PATH`, mounting both files **read-only**. The SSH user
   and port default to `dokku` and `22`. The Docker engine connection is
   root-equivalent on its host. All enabled workers for an instance must use the
   same engine so a replacement can load the image recorded by its predecessor.
   `LAUNCHPAD_BASE_IMAGE` defaults to `nginx:1.27-alpine`; use a pinned digest for
   a release. Allow at least 30 seconds for shutdown so the worker can signal
   and reap local subprocesses. Configure a supervisor to restart the worker
   if it exits after a stalled database operation. Each dispatch has at most 290 seconds; work that
   cannot be confirmed by then is held for reconciliation. Provision space for
   retained per-deployment images and scratch directories left after a forced stop;
   never prune an active worker's engine. An interrupted effect may still be running remotely;
   do not retry it by hand or assume stopping the worker stopped Dokku. See [deployments](deployments.md) for the API and reconcile commands.
   Aliases are a separate switch. With `LAUNCHPAD_ALIASES=off` (the default) the worker never
   reads router settings or contacts the router. With `LAUNCHPAD_ALIASES=on` the worker also
   needs `LAUNCHPAD_ALIAS_INSTANCE_ID`, `LAUNCHPAD_ALIAS_CONTROL_URL` (HTTPS, or HTTP only on
   loopback), `LAUNCHPAD_ALIAS_PROBE_URL` (the router's data plane), and read-only files for
   `LAUNCHPAD_ALIAS_CONTROL_TOKEN_FILE` (mode 0600, owned by the worker's user) and
   `LAUNCHPAD_ALIAS_ROUTER_EPOCH_FILE`. The token file must be a regular file (not a symlink) owned by the worker's user with no group or
   other access; a Kubernetes or Docker secret mounted as a symlink or root-owned 0444 is refused.
   With a private issuing CA, set `LAUNCHPAD_ALIAS_CONTROL_CA_FILE` to a read-only
   PEM CA bundle in both worker and admin environments. It requires an HTTPS
   control URL and affects only router-control requests, not app probes or other
   HTTPS traffic. The server certificate must match the control URL's hostname.
   The worker re-reads both files for each promotion, so
   after an offline router rotation update them before resuming workers (see the
   [router guide](../apps/router/README.md)). A promotion is held, never retried, when the router's
   reply is lost; an operator then runs `promotion-reconcile` after reading the router.

If the status shows a schema mismatch, stop the processes, take a backup and
follow [upgrade](upgrade.md). Do not point a second installation at the same
Dokku host or data directory. See [onboarding](onboarding.md) for users and keys.
