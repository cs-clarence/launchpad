# Behavior-based deployment naming

User-approved scope (2026-11-20): remove "immutable" from implementation names,
including tables, identifiers, tasks, files, recovery records and their references.
Keep the term where it describes the enforced behavior, including SQL's
`IMMUTABLE` volatility declaration.

## Assessment and approach

- **Kind / risk:** bounded cross-component rename, Medium execution size with
  High-risk verification because schema names and durable recovery records change.
- **Extent:** unmerged migration 018, database types/readers, recovery helpers,
  tests/tasks and documentation paths/references. No deployment behavior change.
- **Unknowns:** collision with the legacy `deployment` table and stale references.
  Inspect the destructive DROP-before-CREATE order and test populated upgrades.
- **Undo:** revert this rename before applying 018. No released installation has
  run this PR's migration; intermediate PR builds/records are unsupported, not a
  reason to add a second schema or gate path. The cutover backup/restore rule
  remains unchanged after an installation runs 018.
- **People/time:** one author, one independent read-only review, one bounded pass.
  Work stays together because renamed schema and callers cannot ship separately.

## Steps and acceptance

1. Rename implementation identifiers/paths and update every live caller, SQL
   validator/index/trigger, migration manifest reference, task and documentation
   link. Use `deployment`, `deployment-recovery`, and `deployment_*` names.
   Preserve descriptive immutability assertions and historical branch names.
2. Inspect legacy/new `deployment` distinctions in cutover tests and docs; ensure
   checks still prove the old rows are gone and new constraints enforce behavior.
   Search remaining occurrences and check file/link consistency.
3. Run check/test/build, populated upgrade/cutover/restore integration, image and
   package checks and built-image upgrade drill on approved disposable PostgreSQL.
   Tear it down. Obtain independent read-only review before pushing to PR #58.

Done means no implementation name carries the behavioral adjective, while the
same reservation, identity, recovery and deletion constraints still pass. Expand
the plan and ask if this requires deployed-data compatibility or a behavior change.
