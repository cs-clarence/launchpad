# Database

For contributors adding PostgreSQL access. Keep this page current when
connection ownership or schema changes.

`createDatabase(connectionString)` explicitly constructs Kysely with the
PostgreSQL dialect and a lazy `pg` pool. Importing the package makes no
connection. The eventual composition root must call `destroy()` on shutdown.

The database type is intentionally empty. There are no tables, migrations,
queries, or automatic migration/startup actions in this bootstrap.

See [patterns](../../docs/patterns/README.md).
