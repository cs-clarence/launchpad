# Back up Launchpad state

For an instance operator preserving the controller database and stored site
archives. Backups do **not** contain environment files, the authentication secret,
Dokku state or any preview datastore; back those up separately.

1. If the lifecycle runs anywhere, turn it off and wait for every worker to
   stop. A worker's archive collection can race with the backup. Give the
   worker its full stop grace period. With all workers stopped, add
   `--i-have-stopped-the-workers`; otherwise leave that flag off.
2. Supply `DATABASE_URL` and the controller's actual `LAUNCHPAD_DATA_DIR`
   to the admin command, and a `pg_dump` at least as new as the PostgreSQL
   server (`LAUNCHPAD_PG_DUMP` can name the tool). Choose a **new** destination:

    ```sh
    bun .output/admin.mjs backup /private/backups/launchpad-2026-11-18
    bun .output/admin.mjs verify-backup /private/backups/launchpad-2026-11-18
    ```

    The commands run in the controller image's `/app` with its database and
    `/data` mounts, or use the equivalent
    `omni -i run admin -p @launchpad/controller -a command=backup -a options=<new-dir>`
    from a configured checkout. Mount the destination into the command's
    container if running it in Docker. Do **not** pass a real password on a
    command line. The backup includes a custom-format `database.dump` and
    a checked `manifest.json`, plus the archive files its snapshot refers to.

3. Require `verify-backup` to exit 0, then copy the **whole directory** to
   private, access-controlled storage. A failed or killed backup may leave a
   partial directory without a manifest; never restore it. Keep the database
   dump apart from the auth secret: it contains live session tokens and
   password/API-key hashes.

If backup refuses because a lifecycle worker is live, stop it rather than
asserting the flag. If an archive is missing or has the wrong digest, repair
the source first; a partial database dump is not a working backup. See
[restore](restore.md) to rehearse recovery.
