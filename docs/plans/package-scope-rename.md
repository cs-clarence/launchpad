# Rename the workspace scope

Approved by the user's “Rename now” on 2026-11-19, following the proposal to use
`@launchpad-kit` for all packages.

- **Kind/risk:** Medium repository-wide refactor; no published packages exist.
- **Scope:** replace `@launchpad` with `@launchpad-kit` in package names, imports,
  dependency names, Omni tasks, TypeScript paths, tooling, generators, tests and
  documentation. Keep executable names, product identifiers, database/Dokku
  identifiers, Docker repositories and directory names unchanged.
- **Steps:** inventory all tracked references; rename the scope consistently;
  regenerate `bun.lock` with Bun; check for stale names and verify the package
  graph, builds, tests and packed-client installs outside the workspace.
- **Verification:** `omni -i run check test build`; `test:packages` for registry-free
  workspace tarball resolution and Node/Bun execution. No live infrastructure is
  required or started for this rename.
- **Undo:** revert this change's source edits and regenerate the lockfile; preserve
  the existing uncommitted deployment-plan draft.
- **Not included:** registration/ownership verification, publishing, Docker
  namespace changes, deployment or cleanup. Scope ownership is still unverified.

Verification completed:

- `omni -i run check test build --force all` passed.
- `omni -i run test:packages -p @launchpad-kit/tooling` passed, including Node/Bun
  execution and outside-workspace tarball installation.
- Bun regenerated the lockfile with the new scope, including root metadata.
  The external package resolution entries are unchanged; no dependency update
  is part of this rename.
- Docker image builds and database/Dokku integration checks were not run; no
  service was started. Container build filters and workflow task names were
  updated as part of the source rename.

The repository previously used a placeholder npm scope. This change
selects the new scope in source; it does not claim that a registry namespace has
been registered or is available.
