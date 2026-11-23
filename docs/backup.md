# Back up Launchpad state

For an instance operator preserving the controller database and stored site
archives. Backups do **not** contain environment files, the authentication secret,
Dokku state, the alias router database or any site datastore; back those up separately.

1. Supply `DATABASE_URL` and the controller's actual `LAUNCHPAD_DATA_DIR`
   to the admin command, and a `pg_dump` at least as new as the PostgreSQL
   server (`LAUNCHPAD_PG_DUMP` can name the tool). Choose a **new** destination.
   Close deployment writes before taking a matched snapshot. There is no stop-confirmation
   flag in the current command. If upgrading from a legacy binary, stop its collectors and
   wait for them to exit. A worker with deployments off need not be stopped; stop an enabled worker first: a
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

## Database connection options

For both `backup` and `restore`, `DATABASE_URL` must use `postgres://` or
`postgresql://`. Host, port, user, password and database come from the URL;
the optional `host` query parameter overrides the host (including a Unix socket
directory). Query values are percent-decoded exactly once; `+` is literal
and a space is `%20`.

The PostgreSQL 17 client tools receive these query options through libpq
environment variables, not command-line arguments:

| Query option               | Client environment variable |
| -------------------------- | --------------------------- |
| `host`                     | `PGHOST`                    |
| `sslmode`                  | `PGSSLMODE`                 |
| `sslrootcert`              | `PGSSLROOTCERT`             |
| `sslcert`                  | `PGSSLCERT`                 |
| `sslkey`                   | `PGSSLKEY`                  |
| `sslcrl`                   | `PGSSLCRL`                  |
| `sslcrldir`                | `PGSSLCRLDIR`               |
| `sslsni`                   | `PGSSLSNI`                  |
| `sslcompression`           | `PGSSLCOMPRESSION`          |
| `sslcertmode`              | `PGSSLCERTMODE`             |
| `sslnegotiation`           | `PGSSLNEGOTIATION`          |
| `ssl_min_protocol_version` | `PGSSLMINPROTOCOLVERSION`   |
| `ssl_max_protocol_version` | `PGSSLMAXPROTOCOLVERSION`   |
| `channel_binding`          | `PGCHANNELBINDING`          |
| `gssencmode`               | `PGGSSENCMODE`              |
| `connect_timeout`          | `PGCONNECT_TIMEOUT`         |

Omitted options retain libpq's defaults; values follow
[PostgreSQL 17's connection parameter reference](https://www.postgresql.org/docs/17/libpq-connect.html#LIBPQ-PARAMKEYWORDS).
Unknown, duplicate, empty or NUL-containing query options are refused, rather
than silently ignored. URL fragments are also refused. In particular,
`sslpassword` has no libpq environment equivalent and is unsupported; service
files and query overrides of user/password/port/database are unsupported too.
Connection option errors do not print the URL or option contents.

Certificate paths must exist and be readable inside the admin process/container;
mount certificate files read-only when using Compose. The subprocess environment
does not inherit ambient `PG*` settings. These translations apply only to the
PostgreSQL client tools: they do not add TLS features to Bun SQL, which also
connects during backup/restore. Verify both clients against the intended database
before relying on remote TLS; the unit checks do not establish live certificate
verification or Bun/libpq compatibility. A
[disposable TLS drill](plans/production-pg-client-options.md#disposable-postgresql-tls-drill-2026-11-23)
verified the built admin with PostgreSQL 17 using `sslmode=verify-full` and
`sslrootcert` in `DATABASE_URL` alone. It does not cover all TLS options or
replace verification against your own endpoint.
