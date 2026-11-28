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
`-p <project>` limits a run to one project (`omni -i run check -p @launchpad-kit/auth`),
`--force all` forces a fresh run; `--no-cache` only prevents saving new results.
Use both for a fresh run that does not populate the cache. `-d` prints what would run.
The `bun run <name>` scripts in the root `package.json` are only aliases for the
same Omni tasks; package-level scripts are the commands Omni executes.

A cache hit restores only missing outputs and does not overwrite an existing one (Omni 0.21.0).
A stale, git-ignored `dist/` (for example `apps/cli/dist/cli.mjs` without newer commands, or an old `dist/index.js` left beside it) therefore
survives `omni -i run build`. The cache is shared across checkouts, so another checkout's build can
cause this. Run `omni -i run build -f all`, or delete the project's `dist/` and rebuild.

These tasks need no server, Docker, PostgreSQL or Dokku:

| Command                        | Coverage                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `omni -i run build`            | Controller's production Bun output, CLI, library builds and declarations                   |
| `omni -i run check`            | `check:types`, `check:lint` (warnings fail), `check:format` and `check:deps`               |
| `omni -i run check:deps`       | Package, Omni-graph, import and catalog dependencies agree                                 |
| `omni -i run test`             | Unit tests only: services, auth, the Elysia adapter and the tooling                        |
| `omni -i run format`           | Format the whole repository                                                                |
| `omni -i run check:compose`    | Compose render and shape assertions for `docker-compose.yaml` (Docker CLI; starts nothing) |
| `omni -i run check test build` | The full local gate, in one graph                                                          |

`check:types` for the controller builds it first: the route tree is generated and
git-ignored. Integration tests need a disposable PostgreSQL and are never part of
`test`:

```sh
omni -i run test:db:up            # disposable postgres:17-alpine on 127.0.0.1:55432 (Docker)
omni -i run test:integration      # includes PostgreSQL worker tests with fake Docker and Dokku
omni -i run test:db:down
```

For focused migration/model checks, run
`omni -i run test:deployment-schema -p @launchpad-kit/controller` between `test:db:up`
and `test:db:down`. These uncached tests cover permanent registries and immutable
schema constraints. Recovery gates are covered by controller and services integration tests.

To repeat database initialization, restart, and matched backup/restore
against disposable PostgreSQL, run `omni -i run test:upgrade -p @launchpad-kit/controller`
between `test:db:up` and `test:db:down` **on Linux** (Docker host networking).
`test:integration` runs the host-built variant on other platforms; it does not
exercise the image. The image and packaged-client checks are `omni -i run test:images
-p @launchpad-kit/tooling` (Docker, disposable database) and `omni -i run
test:packages -p @launchpad-kit/tooling` (network, Node and Bun;
`LAUNCHPAD_NODE` picks the Node). These build, inspect and exercise local artifacts, never publish them. The operator
[restore drill](docs/restore.md) is the no-Dokku automated check.

The alias router's integration suite likewise opens loopback listeners (and needs `openssl`) but no
database: `omni -i run test:integration -p @launchpad-kit/alias-router`.
The router app's full integration suite also needs the disposable PostgreSQL
for managed rotation. Its focused control-TLS check needs only `openssl` and
loopback listeners: `omni -i run test:control:tls -p @launchpad-kit/router`.

The controller's built-server integration also drives `launchpad artifact upload`,
`launchpad app deploy` and a separately confirmed MCP promotion through the real
HTTP API with a disposable database. No Dokku or alias router is needed for that test.

The SDK's transport suite uses ephemeral loopback HTTP fixtures instead of the
database: `omni -i run test:integration -p @launchpad-kit/sdk` runs it alone. Fixtures
close after each test; default `test` remains unit-only and opens no listeners.

`test:integration` defaults `TEST_DATABASE_URL` to that container; export it to point
elsewhere. The controller's integration test also needs the built server, which Omni
builds first and starts on a local port. Tests run under Bun (`bun --bun vitest`)
because the database layer uses Bun SQL, and each test file creates and drops its own
database. Integration results are never cached.

The worker also has an opt-in **live** suite, `omni -i run test:live -p @launchpad-kit/worker`,
that builds and deploys a fixture site on a real Dokku and Docker. It is not part of
`test`, `test:integration` or CI, and needs a disposable Dokku you started yourself; it
creates and removes only `lp-test-` apps. Its settings are in the header of
`apps/worker/src/__tests__/live.spec.ts`.

The production-preparation routing experiment is separately opt-in:
`LAUNCHPAD_ROUTING_EXPERIMENT=1 omni -i run test:routing:experiment -p @launchpad-kit/tooling`.
It creates its own disposable Dokku, two fixture apps, a worker and experimental
router, with no published host ports. It needs Docker and host `ssh-keygen`/`openssl`,
uses the host engine socket (root-equivalent), and must not be run without explicit
permission to start disposable services. See
[scope and evidence](docs/plans/routing-experiment-evidence.md). It is not in CI.

The full-stack P7 rehearsal is separately opt-in:
`LAUNCHPAD_ACCEPTANCE_REHEARSAL=1 omni -i run test:acceptance:rehearsal -p @launchpad-kit/tooling`.
It builds the controller, worker and router images, starts a disposable PostgreSQL and Dokku
(`launchpad/dokku:0.38.34`) with no published host ports, and drives the worked acceptance example
over the real HTTP API (about 20 minutes, mostly a real five-minute lease expiry). It needs Docker
and host `ssh-keygen` and `tar`, uses the host engine socket (root-equivalent), and must not be run
without explicit permission to start disposable services. `LAUNCHPAD_ACCEPTANCE_FAST_LEASE=1`
expires the stale lease by SQL instead of waiting (for iterating on the harness only) and
`LAUNCHPAD_ACCEPTANCE_RACE_ROUNDS` sets the number of promotion-versus-deletion rounds (default 3).
Resources are recorded in `/tmp/opencode/lp-accept-*/resources.json` before creation and removed
by exact name. It is not in CI. See [the acceptance record](docs/plans/deployment-p7-acceptance.md).
SIGINT and SIGTERM delivered to the harness cancel its waits and signal-aware
requests. An in-flight Docker command can delay cleanup until it exits or
reaches its 15-minute deadline. Do not force-kill the harness during cleanup.
If cleanup cannot verify settlement or save the inventory, it leaves the
affected fixture resources for diagnosis; see `cleanup.log` and `resources.json`.

With explicit approval to serve throwaway sites through an existing HTTPS
wildcard, set `LAUNCHPAD_ACCEPTANCE_INGRESS_DOMAIN` as well. This runs a separate
smoke test instead of the full story: after S3 it briefly binds `127.0.0.1:9080`,
serves only two fixture deployment hosts and one fixture alias, and checks public
HTTPS before promotion, after promotion and after withdrawal. The test neither
configures the tunnel nor exposes the controller or router control port. It
requires a run-specific forwarding marker even on the withdrawn alias's 404.

`omni -i run check:compose:rehearsal` renders the disposable aliases-on
Compose fixture with generated settings and validates its isolation. It
requires the Compose CLI but does not start Docker resources.
With approval to start disposable infrastructure, use
`LAUNCHPAD_COMPOSE_REHEARSAL=1 omni -i run test:compose:rehearsal -p @launchpad-kit/tooling`.
It uses the local Docker socket (root-equivalent), OpenSSL, `ssh-keygen` and
`tar`, and runs only on a trusted host. It binds loopback ports, records an
inventory under `/tmp/opencode/lp-compose-*`, and stops writers and retains
the fixture if it cannot verify deletion and Dokku settlement. It never
force-destroys Dokku apps. It is not in CI or the default tests. Two opt-in modes extend the
baseline: `LAUNCHPAD_COMPOSE_READ_ONLY=1` runs the application services with read-only root
filesystems, and `LAUNCHPAD_COMPOSE_CAPACITY=1` adds timed uploads and deploys at the default
limits, concurrent deploys and a backup, with sampled peak resource use (about 16 minutes). See the
[rehearsal plan](docs/plans/production-compose-rehearsal.md) for limitations.

For the separate end-to-end restore drill, also set
`LAUNCHPAD_ACCEPTANCE_RESTORE_DRILL=1` (without ingress or fast lease mode).
It uses the built admin image and a second disposable database, leaves the
source intact, and waits out both the writer drain and the real recovery gate.
Allow more than 30 minutes. See [the drill procedure](docs/plans/deployment-p7-acceptance.md#repeat-the-restore-drill-against-a-newer-router).

Operator and development tasks live in the controller project:

```sh
omni -i run dev -p @launchpad-kit/controller                  # dev server (uses apps/controller/.env.local)
omni -i run admin -p @launchpad-kit/controller -a command=migrate
```

To seed a running local controller with accounts, an organization, a project and a CLI profile, use
`omni -i run local:seed`; see [run Launchpad on your machine](docs/local-quickstart.md). To run
the whole stack and deploy a site locally with Docker, see
[deploy a site on your machine](docs/local-deploy.md). To run the controller, worker and CLI on the
host against PostgreSQL, Mailpit, Dokku and the router in Docker (`docker-compose.dev.yaml`), see
[develop against local infrastructure](docs/local-dev-infra.md):

```sh
omni -i run dev:infra:up          # start (or resume) the infrastructure, write .dev-infra/env/*.env
omni -i run dev:infra:status      # health, ports, deployed sites
omni -i run dev:infra:down        # stop, keep the data
omni -i run dev:infra:destroy     # remove everything it created
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
| `commits`     | Conventional Commits check of the pull request's commits (pull requests and dispatched runs)                     |
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
`package.json`. The only workflow that publishes is `.github/workflows/release.yaml` (the
[release publishing decision](docs/decisions/release-publishing.md)): it starts only on a pushed
`v<semver>` tag, never on a pull request, and each publishing job waits for approval of the
`release` environment. It has not run yet. Every other workflow is checked by `tooling/ci.spec.ts`
for publish, push, tag and login commands and for credentials; the release workflow has its own
`tooling/release.spec.ts`, and its decisions are in `tooling/release-plan.ts`. The manual **Release PR** workflow (`.github/workflows/release-pr.yaml`, `workflow_dispatch` from `main` only) opens the release pull request: it pushes a `release/<version>` branch and opens a PR, and never tags or publishes (`tooling/release-pr.spec.ts`; `ci.spec.ts` carves out exactly its one branch push); `ci.yaml` accepts `workflow_dispatch` so CI can run on that branch. The manual **Release dry run** workflow
(`omni -i run release:dry-run -p @launchpad-kit/tooling`) rehearses a release without publishing; see
[releasing](docs/releasing.md) for versioning, compatibility rules and the release checklist.

No CI-only checks exist: anything CI runs you can run locally with the commands above. Install the Cocogitto commit-msg hook
locally with `cog install-hook --all`; it validates Conventional Commit messages
and checks this branch's commits (`origin/main..HEAD`), the range CI checks. Browser tests, live
SSH tests and deployment tests are not part of the default checks; image builds run in
the integration job.
See [tooling](docs/tooling.md) and [patterns](docs/patterns/README.md).

## Risk

Changes to authentication, authorization, schema or migrations, secrets and
production configuration, or deployment execution are always High risk, even
when the diff looks small. Size verification and review accordingly; the exact
paths and reasons are in [risk overrides](docs/risk-overrides.md).

## Git

This repository was initialized on `main` with no commits, so no established
commit or merge convention was detected. The approved starting convention is:
short-lived `<type>/<short-slug>` branches, focused Conventional Commit messages
(for example `feat: add a preview`), as configured in `cog.toml`,
PRs and squash merges, and no force-pushes to shared branches or committed
secrets.

Titles must be Conventional Commit (semantic) messages: `<type>[(scope)]: <summary>`, for
example `feat(worker): add an optional worker id` or `fix: check only the branch's commits`.
This applies to every commit message **and to the PR title**, because a squash merge uses the
PR title as the commit on `main`, so a title like `Add an optional LAUNCHPAD_WORKER_ID (#86)`
fails `cog check`. Allowed types are the Conventional Commit set (`feat`, `fix`, `docs`,
`chore`, `refactor`, `test`, `perf`, `build`, `ci`, `style`, `revert`). The `Check Commits`
job and the commit-msg hook enforce it on the commits of a PR, not on the PR title, so
check the title yourself before merging. Check a message with `cog verify "<title>"`. Passing checks and one review are recommended before merging, but
branch protections and remote settings have not been configured.
