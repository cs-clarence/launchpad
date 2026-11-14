# Database

For contributors adding PostgreSQL access or schema. Keep this page current when
connection ownership or the schema changes.

- `createDatabase(url)` constructs Kysely on Bun's native PostgreSQL client
  (`Bun.SQL`) through `BunSqlDialect` in `src/bun-sql-dialect.ts`. Better Auth is
  given the same Kysely instance. The package therefore needs the Bun runtime,
  and tests run under `bun --bun vitest`. Importing it makes no connection; the
  composition root closes the instance once with `destroy()`. The dialect is
  our own (about 80 lines) because `kysely-bun-sql` pins Kysely 0.28.
- `migrateToLatest(db)` (`src/migrate.ts`) runs the forward-only migrations in
  `src/migrations`: one file per migration (`up` only, `Kysely<any>` and raw SQL,
  frozen in time), named `<ISO date>_<sequence>_<what>`. Kysely's
  `FileMigrationProvider` discovers them, so adding a migration is adding a file;
  files exporting no migration (like the frozen auth SQL) are ignored. Kysely
  locks the database, so concurrent runs apply each migration once, and refuses a
  new migration that sorts before an applied one. The folder must ship with the
  module, which a bundled or compiled distribution has to account for.
  Nothing runs them automatically; use `omni run admin -p @launchpad/controller -a command=migrate`.
- `20261114_001_auth_schema` is SQL generated once from Better Auth 1.7.23,
  reviewed and frozen. Change the schema with a new migration, never by editing
  or regenerating it. `20261114_002_instance_constraints` adds the role check,
  the single-operator index and unique organization membership.
- Auth tables use Better Auth's camelCase columns; Launchpad tables use snake_case.
  `Database` describes only the columns Launchpad reads or writes directly.
- `@launchpad/database/testing` creates and drops a throwaway database for
  integration tests (`TEST_DATABASE_URL`).

See [patterns](../../docs/patterns/README.md).
