# Contributing

For contributors working on the Launchpad controller and CLI.
Keep this document current when commands or workflow change.

## Tasks

**Omni is the entrypoint for everything.** Use Bun 1.4.4 and Omni. Install
dependencies and projected agent context:

```sh
bun install --frozen-lockfile
omni remote-sources install && omni projection sync     # or: bun run setup:agents
```

Run tasks with `omni -i run <task>...` (`-i` passes your shell environment, such as
`DATABASE_URL` or `TEST_DATABASE_URL`, to tasks; the released Omni drops it without `-i`). Omni orders them by the project graph
(`^build`: a project's upstream dependencies build first), runs independent ones in
parallel, and caches results keyed on each project's sources, so a second run of an
unchanged project is instant and a changed dependency re-runs its dependents.
`-p <project>` limits a run to one project (`omni -i run check -p @launchpad/auth`),
`--force all` forces a fresh run; `--no-cache` only prevents saving new results.
Use both for a fresh run that does not populate the cache. `-d` prints what would run.
The `bun run <name>` scripts in the root `package.json` are only aliases for the
same Omni tasks; package-level scripts are the commands Omni executes.

These tasks need no server, Docker, PostgreSQL or Dokku:

| Command                        | Coverage                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `omni -i run build`            | Controller's production Bun output, CLI, library builds and declarations     |
| `omni -i run check`            | `check:types`, `check:lint` (warnings fail), `check:format` and `check:deps` |
| `omni -i run check:deps`       | Package, Omni-graph, import and catalog dependencies agree                   |
| `omni -i run test`             | Unit tests only: services, auth, the Elysia adapter and the tooling          |
| `omni -i run format`           | Format the whole repository                                                  |
| `omni -i run check:compose`    | Existing Dokku Compose syntax (needs the Docker CLI)                         |
| `omni -i run check test build` | The full local gate, in one graph                                            |

`check:types` for the controller builds it first: the route tree is generated and
git-ignored. Integration tests need a disposable PostgreSQL and are never part of
`test`:

```sh
omni -i run test:db:up            # disposable postgres:17-alpine on 127.0.0.1:55432 (Docker)
omni -i run test:integration      # auth/services/controller on PostgreSQL; SDK loopback fixtures
omni -i run test:db:down
```

To repeat the frozen previous-schema backup → migrate → restart → restore drill
against disposable PostgreSQL, run `omni -i run test:upgrade -p @launchpad/controller`
between `test:db:up` and `test:db:down` **on Linux** (Docker host networking).
`test:integration` runs the host-built variant on other platforms; it does not
exercise the image. The image and packaged-client checks are `omni -i run test:images
-p @launchpad/tooling` (Docker, disposable database) and `omni -i run
test:packages -p @launchpad/tooling` (network, Node and Bun). These build,
inspect and exercise local artifacts, never publish them. The operator
[restore drill](docs/restore.md) separates the no-Dokku automated checks from
the opt-in isolated-host rehearsal (`test:restore:live`, guarded and never in CI).

The SDK's transport suite uses ephemeral loopback HTTP fixtures instead of the
database: `omni -i run test:integration -p @launchpad/sdk` runs it alone. Fixtures
close after each test; default `test` remains unit-only and opens no listeners.

`test:integration` defaults `TEST_DATABASE_URL` to that container; export it to point
elsewhere. The controller's integration test also needs the built server, which Omni
builds first and starts on a local port. Tests run under Bun (`bun --bun vitest`)
because the database layer uses Bun SQL, and each test file creates and drops its own
database. Integration results are never cached.

The worker also has an opt-in **live** suite, `omni -i run test:live -p @launchpad/worker`,
that builds and deploys a fixture site on a real Dokku and Docker. It is not part of
`test`, `test:integration` or CI, and needs a disposable Dokku you started yourself; it
creates and removes only `lp-test-` apps. Its settings are in the header of
`apps/worker/src/__tests__/live.spec.ts`.

Operator and development tasks live in the controller project:

```sh
omni -i run dev -p @launchpad/controller                  # dev server (uses apps/controller/.env.local)
omni -i run admin -p @launchpad/controller -a command=migrate
```

Omni loads `.env.local` files from the repository root and from the project into task
environments, unexpanded. Keep only values you want every task to see in the root file.

Adding a package: use the Omni generator (see [tooling](docs/tooling.md)); it produces
a package that passes `omni -i run check test build` as generated.

## CI

`.github/workflows/ci.yaml` runs the same Omni tasks you run locally, as a chain of
jobs on pushes to `main`, pull requests and the merge queue:

| Job           | Runs                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `commits`     | Conventional Commits check of the pull request's commits (PRs only)                                              |
| `check`       | `omni -i run check check:compose`: types, lint, format, dependency consistency                                   |
| `build`       | `omni -i run build`                                                                                              |
| `test`        | `omni -i run test` (unit tests)                                                                                  |
| `integration` | Disposable database, `test:integration` (host-built variant), `test:images`, `test:upgrade` (built image; Linux) |
| `packages`    | `test:packages`: install packed clients outside the workspace                                                    |
| `CI Passed`   | The gatekeeper: runs last and always, and fails unless every job passed                                          |

**Require only `CI Passed`** in the `main` branch protection or ruleset. GitHub cannot
match job names that change, and a required job that is skipped never reports, so the
single stable gate stands for all of them. It is deliberately strict: the four core
jobs must each be exactly `success` (a skipped job fails the gate, as happens when an
earlier job failed), and `commits` must be `success` on pull requests and `skipped`
otherwise. Branch protection is not configured by this repository; set it in the
repository settings.

Jobs restore the Omni cache (`.omni`) so unchanged projects are skipped; this is only
safe because every task's cache key names its inputs (see [tooling](docs/tooling.md)).
The Omni version is pinned in `.github/actions/setup-workspace/action.yaml`: raise it
together with the version you use locally. Bun comes from `packageManager` in
`package.json`. Nothing is published or deployed from CI yet.

No CI-only checks exist: anything CI runs you can run locally with the commands above. Install the Cocogitto commit-msg hook
locally with `cog install-hook --all`; it validates Conventional Commit messages
and checks existing history once the repository has a first commit. Browser tests, live
SSH tests and deployment tests are not part of the default checks; image builds run in
the integration job.
See [tooling](docs/tooling.md) and [patterns](docs/patterns/README.md).

## Git

This repository was initialized on `main` with no commits, so no established
commit or merge convention was detected. The approved starting convention is:
short-lived `<type>/<short-slug>` branches, focused Conventional Commit messages
(for example `feat: add a preview`), as configured in `cog.toml`,
PRs and squash merges, and no force-pushes to shared branches or committed
secrets. Passing checks and one review are recommended before merging, but
branch protections and remote settings have not been configured.
