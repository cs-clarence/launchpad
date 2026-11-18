# Install a private Launchpad instance from built artifacts

For an instance operator preparing a **private** Linux/amd64 installation. This
guide wires the artifacts and explains the checks; it does not supply a production
Compose stack, TLS ingress, host ports, a Dokku backup, or permission to expose
the controller publicly. Those are the [separate production follow-up](plans/production-compose-follow-up.md).

1. Provision one PostgreSQL database **owned by the runtime role**, a durable data
   volume, and a separate Dokku host. Use one Launchpad database and data directory
   per Dokku host. Provide a PostgreSQL client at least as new as the server for
   backups; `pg_dump`/`pg_restore` are not included in the controller image.
2. Build the images from the repository root with BuildKit:

    ```sh
    version="$(bun -p 'require("./package.json").version')"
    docker build --build-arg LAUNCHPAD_VERSION="$version" -f containers/controller/Dockerfile -t launchpad/controller:local .
    docker build --build-arg LAUNCHPAD_VERSION="$version" -f containers/worker/Dockerfile -t launchpad/worker:local .
    ```

    The build argument records the version in backups and in the operator status; an image
    built without it reports `unknown`.

    These are local tags, not published images. Both images run as uid/gid 10001.
    Mount the **same** durable `/data` into both; a bind mount must be owned by
    10001:10001. Without an explicit mount, each gets a separate anonymous volume.
    See [tooling](tooling.md#configuration-and-containers) for image caveats.

3. Supply `DATABASE_URL`, `LAUNCHPAD_AUTH_SECRET` (at least 32 random characters),
   `LAUNCHPAD_BASE_URL` (the exact HTTPS origin used by browsers), and
   `LAUNCHPAD_DATA_DIR=/data` to the controller **at runtime**, never in an image.
   Start with `LAUNCHPAD_DEPLOYMENTS=off` and `LAUNCHPAD_LIFECYCLE=off` in **both**
   processes. Keep the database and admin command private. Use
   [the controller settings reference](../apps/controller/README.md#configuration)
   and [worker settings](../apps/worker/README.md#settings) for remaining values.
4. Run `bun .output/admin.mjs migrate --status` in the controller image with
   `DATABASE_URL` set. On a fresh database, a nonzero exit with pending migrations
   is expected. Run `bun .output/admin.mjs migrate` explicitly, then run
   `migrate --status` again; it must report `pending: 0` and exit 0. Neither process
   migrates on startup. The worker and controller refuse an incompatible schema.
5. Start the controller with its private listener connected to the database and
   shared volume. Verify `/api/health`, then sign in after running
   `bun .output/admin.mjs setup --email <operator-address> --password-file <mode-600-file>`
   in the controller image with the auth settings. The mode-`0600` password
   file must be readable by the admin process (the stock image runs as UID
   `10001`; a host-owned `0600` file with another UID will not work). The health endpoint reports
   static metadata, **not** database/Dokku readiness; use the signed-in
   operator-only `GET /api/v1/status` for runtime state.
6. Mount the Dokku SSH key and pinned `known_hosts` file **read-only** into the
   worker, and provide its Docker engine connection; the controller must not
   have those credentials. Docker-socket access is root-equivalent on the host.
   Give the worker a 25-minute stop grace period (`docker stop --time 1500` or
   `stop_grace_period: 25m`) before enabling deployments. Configure the same
   upload limits and deployment/lifecycle switches in both processes. Only
   enable deployments after private [routing](access.md) and a
   [backup/restore rehearsal](restore.md) have been checked; enable lifecycle
   separately after reviewing preview expiry.

If the status shows a schema mismatch, stop the processes, take a backup and
follow [upgrade](upgrade.md). Do not point a second installation at the same
Dokku host or data directory. See [onboarding](onboarding.md) for users and keys.
