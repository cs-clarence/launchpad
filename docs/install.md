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
   Keep the database and admin command private. Use
   [the controller settings reference](../apps/controller/README.md#configuration)
   for remaining values. The worker reads no settings while it is idle.
4. Run `bun .output/admin.mjs migrate --status` in the controller image with
   `DATABASE_URL` set. On a fresh database, a nonzero exit with pending migrations
   is expected. Run `bun .output/admin.mjs migrate` explicitly, then run
   `migrate --status` again; it must report `pending: 0` and exit 0. Neither process
   migrates on startup. The controller refuses an incompatible schema.
5. Start the controller with its private listener connected to the database and
   shared volume. Verify `/api/health`, then sign in after running
   `bun .output/admin.mjs setup --email <operator-address> --password-file <mode-600-file>`
   in the controller image with the auth settings. The mode-`0600` password
   file must be readable by the admin process (the stock image runs as UID
   `10001`; a host-owned `0600` file with another UID will not work). The health endpoint reports
   static metadata, **not** database/Dokku readiness; use the signed-in
   operator-only `GET /api/v1/status` for runtime state.
6. The worker is idle (the preview runtime was removed) and needs no database, Dokku or Docker
   access; you may leave it stopped. When the app worker returns, it will need the Dokku SSH key
   and pinned `known_hosts` mounted **read-only**, a Docker engine connection (root-equivalent
   on the host), and a 25-minute stop grace period. Enable deployments only after private
   [routing](access.md) and a [backup/restore rehearsal](restore.md) have been checked.

If the status shows a schema mismatch, stop the processes, take a backup and
follow [upgrade](upgrade.md). Do not point a second installation at the same
Dokku host or data directory. See [onboarding](onboarding.md) for users and keys.
