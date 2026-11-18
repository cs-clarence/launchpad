# Previous-schema upgrade fixture

`schema-014.dump` is a PostgreSQL 17 custom-format dump of a disposable Launchpad
database after migrations `001`–`014` (ending in `20261116_014_deletion_fence`).
It contains one synthetic user, `upgrade-fixture@example.invalid`, with no
credentials. It is deliberately **not** regenerated from the latest schema in
tests: a future migration must prove it can upgrade this frozen database.

To replace it for a later tagged version, use a disposable PostgreSQL 17 database,
apply only the migrations present in that version, insert synthetic data, and
dump `public` with `pg_dump -Fc --no-owner --no-privileges --schema=public`.
Keep this fixture as the prior-version upgrade target until a newer version
supersedes it; never dump a real installation into the repository.
