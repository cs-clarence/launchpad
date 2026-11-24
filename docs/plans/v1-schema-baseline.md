# Clean v1 schema baseline

## Scope and assessment

Large repository change, high risk: migrations, database startup and restore,
configuration, tests, and operator docs must agree. The operator approved a
fresh database for v1 and no compatibility with earlier databases or backups.
No installed resources will be changed. The main unknown is schema parity:
constraints, indexes, and functions must match the current supported model
without replaying retired changes. Work can proceed in bounded slices with one
combined check. Reverting before v1 is shipped is a code rollback; reverting
after data is written is not an in-place database downgrade. This plan does not
cover importing data from earlier builds; adding that would change the scope.

## Sequence

1. Replace the pre-release migration chain with a new first migration that
   creates the current schema directly. Compare its catalog with the existing
   current schema on disposable PostgreSQL. Use a new migration identity so
   earlier migration journals cannot be mistaken for the new baseline.
2. Update startup, migrate, backup, and restore to agree on the baseline.
   Verify empty install and current-format restore work; verify an incompatible
   journal or manifest fails before application data changes. Keep tests for
   schema constraints, recovery fencing, rollback, and generic rejection of
   unknown API scopes. Retire version-specific cutover tests and SQL fixtures.
3. Remove obsolete configuration checks, tests, and docs. Keep preview URLs
   and expiry for current deployments. Update links and operator instructions
   so a clean install is the documented starting point.
4. Run the Omni gate, database and built-image checks on disposable
   infrastructure, and review the full change before shipping. On any parity
   or refusal failure, keep the baseline unshipped and preserve the evidence.

## Verification so far

On disposable PostgreSQL 17, schema-only dumps of the prior current model and
the v1 baseline matched after excluding migration bookkeeping tables and
`pg_dump`'s per-run restriction markers. The baseline also seeded the ready
recovery gate. Startup schema validation and `migrate` refused the earlier
journal, and the reference schema remained unchanged.
