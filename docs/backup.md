# Back up Launchpad state

For an instance operator preserving the controller database and stored site
archives. Backups do **not** contain environment files, the authentication secret,
Dokku state or any preview datastore; back those up separately.

1. Supply `DATABASE_URL` and the controller's actual `LAUNCHPAD_DATA_DIR`
   to the admin command, and a `pg_dump` at least as new as the PostgreSQL
   server (`LAUNCHPAD_PG_DUMP` can name the tool). Choose a **new** destination.
   Nothing collects archives while the preview runtime is removed, so there is
   no worker check and no stop-confirmation flag. Older-version collectors can
   still move files against the unchanged schema: stop them and wait for them
   to exit before backing up. A worker with deployments off need not be stopped; stop an enabled worker first: a
   snapshot taken mid-step restores as `reconciliation-needed` work.

    ```sh
    bun .output/admin.mjs backup /private/backups/launchpad-2026-11-18
    bun .output/admin.mjs verify-backup /private/backups/launchpad-2026-11-18
    ```

    First build with `omni -i run build -p @launchpad-kit/controller`, then run
    these commands from `apps/controller/` in a configured checkout
    (or an admin environment with a
    compatible PostgreSQL client installed); the stock controller image
    does **not** include `pg_dump`, but the **operator image** does (build it with
    `--target admin`; see [install](install.md)), and its entry point is the admin command, so
    `docker run --rm <admin-image> backup ...` needs no other client.
    Alternatively use
    `omni -i run admin -p @launchpad-kit/controller -a command=backup -a "options=<new-dir>"`
    from a configured checkout. With the operator image,
    supply the database configuration, the controller's `/data` and the backup
    destination as mounts. Do **not** pass a real password on a
    command line. The backup includes a custom-format `database.dump` and
    a checked `manifest.json`, plus the archive files its snapshot refers to.

2. Require `verify-backup` to exit 0, then copy the **whole directory** to
   private, access-controlled storage. A failed or killed backup may leave a
   partial directory without a manifest; never restore it. Keep the database
   dump apart from the auth secret: it contains live session tokens and
   password/API-key hashes.

If an archive is missing or has the wrong digest, repair
the source first; a partial database dump is not a working backup. See
[restore](restore.md) to rehearse recovery.
