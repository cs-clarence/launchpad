# Tooling

For contributors configuring or extending the scaffold. Keep this page current
when tools, generators, or their commands change.

## Workspace

- Bun 1.4.4 manages `apps/*`, `packages/*`, and future `tests/*` workspaces.
  Dependency versions are centralized in the root catalog and resolved in
  `bun.lock`.
- Omni discovers `project.omni.yaml` files and provides project tasks,
  generators, and pinned Git projections. `omni project list` and
  `omni gen list` inspect discovery. It is the single entrypoint: see
  [Omni tasks](#omni-tasks).
- TypeScript 7 checks types; `@typescript/typescript6` provides the compiler API
  required by declaration tooling, as in Pureform.
- Vite builds libraries and the controller; Nitro's `bun` preset emits the
  controller's `.output/`. No custom HTTP/static-file server is maintained.
- The CLI and the separate local MCP app are built with Vite into one ES module each
  (`apps/cli/dist/cli.mjs`, `apps/mcp/dist/mcp.mjs`, with a `#!/usr/bin/env node` line taken from the
  source) that imports its dependencies instead of bundling them. Build MCP with
  `omni -i run build -p @launchpad-kit/mcp`.
  MCP uses the official MIT-licensed `@modelcontextprotocol/sdk` (pinned in the
  catalog at 1.32.2) for stdio framing, capability negotiation and tool schemas,
  not a custom protocol implementation. Only stdio modules are imported.
  The controller's integration tests build the MCP and CLI first and run their built
  files over stdio against the built controller.
- Vitest, Oxfmt, and Oxlint provide tests, formatting, and linting. Commands are
  in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Omni tasks

Every project extends a preset in `omni/presets` (all of them extend `ts.omni.yaml`),
which defines the shared tasks: `build`, `check:types`, `check:lint`, `check:format`,
`check`, `test:unit`, `test:integration` and `test`. The `tooling/` project holds
repository-wide tasks that belong to no package (whole-repo format, tooling types and
lint, `check:deps`, `check:compose`, `test:db:up`/`down`, `test:packages`, `test:images`, and tests of this tooling).

Rules that keep the graph correct:

- **Project dependencies mirror `package.json`.** A workspace dependency must appear in
  both `package.json` (`workspace:^`) and the project's `dependencies:` in
  `project.omni.yaml`, otherwise Omni will not order or invalidate its tasks after the
  dependency. `omni -i run check:deps` (`tooling/check-deps.ts`) enforces this, plus: every
  imported package is declared, no runtime dependency is dead (peers of other
  dependencies excepted), versions come from the root catalog (`catalog:`) or the
  workspace, and every catalog entry is used by a package or a generator template.
- **Cache keys name every file a task reads.** Omni's default key does not include
  sources, so a task without `cache.key.files` stays "cached" after the code it checks
  has changed (this was observed here). `ts.omni.yaml` lists the sources and shared config;
  add a task's own inputs with `cache.key.files.append`. `tooling/presets.spec.ts`
  guards the preset. Tasks that depend on external state (`test:integration`, the
  repository-wide `tooling` checks, `dev`, `admin`) are not cached.
- **`^build` orders and invalidates.** Tasks depend on `^build` so upstream projects
  build first and their outputs change dependents' keys. A project that needs generated
  files (the controller's route tree) lists its `build` as a dependency and its
  generated files as build outputs.
- **Runtime.** `check:runtime` (part of `check`) fails when a published npm
  package's source uses a Bun-only API; see `docs/releasing.md`.
- **Packaging.** `omni -i run test:packages -p @launchpad-kit/tooling` builds the SDK, contracts, CLI and
  MCP server and client-core, packs the five packages (`tooling/package-clients.ts`: a generated
  manifest per package; contracts, SDK and client-core as libraries, the CLI and MCP as executables
  whose dependencies are external), installs the tarballs in clean projects outside the workspace
  with Bun and with the real npm of the selected Node, and runs them under Bun and, when it is on
  the PATH, Node (CLI and MCP `--help`, an MCP handshake, an SDK call against a local server, a
  credential store read and a strict TypeScript check of the declarations). It also checks the
  tarballs hold no `.env`, source, tests, source maps or `workspace:`/`catalog:` specifiers, that
  the five form a closed set at one version, and that nothing is bundled (bare-import allowlist,
  size budgets, marker strings); see `docs/releasing.md`. The `ts-package` generator follows the
  same rule: a published CLI externalizes its dependencies. It needs the network and publishes nothing; the package
  names are placeholders until the product name is decided. CI runs it as the `Packages` job.
- **`test` is unit tests only.** `test:integration` is explicit. Auth, services and
  controller integration need disposable PostgreSQL (`omni -i run test:db:up`).
  The SDK's integration suite only uses ephemeral loopback HTTP fixtures; run it
  alone with `omni -i run test:integration -p @launchpad-kit/sdk`. No database is needed.
- **Database package tests.** `@launchpad-kit/database` has unit tests (the error classifier) and integration
  tests (the migrations, including the schema-rollback gate); both follow the services layout.
- **Built database drill.** `omni -i run test:upgrade -p @launchpad-kit/controller`
  initializes a fresh database, restarts the controller and verifies backup and
  restore on disposable PostgreSQL. No Dokku is touched.
- **Deployment schema.** `omni -i run test:deployment-schema -p @launchpad-kit/controller`
  exercises permanent registries, immutable intents and deferred constraints.
- **Production Compose configuration.** `docker-compose.yaml` and its placeholder-only
  `docker-compose.env.example` are checked by `tooling/compose-production.ts`:
  `omni -i run check:compose` renders the file with
  `docker compose config` in a minimal environment (it starts nothing; the Docker CLI is
  needed) and asserts it fails without required settings; `tooling/compose-production.spec.ts`
  (in `test`, no Docker) runs the same assertions on the raw YAML after interpolating the
  example settings. Both are uncached like every `tooling` task, so the cache-key rules are
  unaffected. The same task asserts that every external base image in the application and Dokku
  Dockerfiles is pinned by digest and the Dokku plugin by commit, and that every service has
  memory, CPU and process limits. It also asserts that `LAUNCHPAD_WORKER_STALE_AFTER` is the same on
  the controller and the worker, that the schema-check settings reach the controller only, and that the
  controller healthcheck waits longer than the 2 s liveness deadline. They prove the configuration's shape, not that the stack runs
  (a one-time disposable run is recorded in `docs/plans/evidence/p7-compose-20261121/`). See
  [production Compose](production-compose.md).
- **Disposable Compose preflight.** `omni -i run check:compose:rehearsal`
  renders production Compose with per-run names, fixture settings and image
  overrides from `tooling/experiments/compose/fixture.ts`. The Docker CLI
  renders only; no engine, ports or fixtures are started. Unit tests exercise
  refusal of unsafe mounts, ports and shared resources. The separate
  `test:compose:rehearsal` opt-in task shares this preflight and exercises
  the live aliases-on baseline. Its lifecycle is in `run.ts`, with controller
  requests and data-plane probes in `scenario.ts`. See the
  [rehearsal plan](plans/production-compose-rehearsal.md).
- **Disposable routing experiment.** The opt-in `test:routing:experiment` tooling task
  builds a worker image, deploys two fixtures through pinned SSH to its own Dokku,
  and exercises the experimental generation-checked Bun/SQLite router. It has no
  default/CI dependency and needs `LAUNCHPAD_ROUTING_EXPERIMENT=1` plus explicit
  approval to start disposable infrastructure. Child commands use minimal
  environments rather than production `.env.local` settings. Resource inventory,
  cleanup scope, evidence and limitations are in
  [the experiment record](plans/routing-experiment-evidence.md).
- **Full-stack acceptance rehearsal.** The opt-in `test:acceptance:rehearsal` tooling task
  (`tooling/experiments/acceptance/`, `LAUNCHPAD_ACCEPTANCE_REHEARSAL=1`) runs the built
  controller, worker and production router images against a disposable PostgreSQL and a
  disposable Dokku, and drives the worked acceptance example over the real HTTP API. Where a
  scenario cannot be driven black-box it uses a named mechanism (a SQL read, `docker pause`, a
  fault proxy in front of the router's control plane) and records it in the evidence. Like the
  routing experiment it records its resources before creating them, passes no repository
  environment to child commands, publishes no host ports, removes only exact recorded names and
  verifies their absence. Never in CI or a default task. The `rules.ts` fault matching has a unit
  test that runs with `test:unit`. Evidence and results:
  [P7 acceptance](plans/deployment-p7-acceptance.md).
  `LAUNCHPAD_ACCEPTANCE_INGRESS_DOMAIN` opts into the separate public ingress
  smoke mode: a temporary exact-host listener on `127.0.0.1:9080` forwards only
  the selected fixture requests. Wildcard DNS must already point to the tunnel,
  and the connector must have a matching wildcard ingress route forwarding to
  `http://127.0.0.1:9080` from its network namespace.
  `LAUNCHPAD_ACCEPTANCE_RESTORE_DRILL=1` opts into a separate isolated restore
  run using the built `admin` image and an empty second database and archive
  directory. It includes the real writer drain and 25-minute recovery wait and
  cannot be combined with public ingress or fast lease mode.
- **Local seed.** `omni -i run local:seed` (`tooling/local-seed.ts`, options through
  `-a "options=..."`) prepares a controller you started yourself for development: it runs the
  controller's `admin` task (`migrate`, `setup`, `create-user`, then `verify-email`) through Omni
  without a shell, then signs in over HTTP to create an organization, a project and an API key, and
  saves the key with `login` from `@launchpad-kit/client-core` so the profile is what
  `launchpad login` writes. It starts no server or database, takes passwords only from mode-600
  files and prints no secret. Its tests use a fake `fetch` and a fake command runner;
  `tooling/local-quickstart.spec.ts` fails when the guide
  ([run Launchpad on your machine](local-quickstart.md)) names an Omni task, script flag, admin or
  CLI command, setting or link that no longer exists. Update the guide with the script.
- **Script arguments.** The tooling scripts that take options (`local-seed.ts`, `local-deploy.ts`,
  `versions.ts`, `test-db.ts`, `release-dry-run.ts`) parse them with commander, imported only through `@commander-js/extra-typings`. `tooling/cli.ts` is the
  shared helper for the option-table scripts: one option table per script feeds commander, the
  `VALUE_FLAGS`/`SWITCH_FLAGS` lists the documentation tests read and the option list of `HELP`, and
  commander's errors become the script's own wording and exit codes. `--flag value` and
  `--flag=value` both work; `--` and a value starting with `--` are still refused. `commander` and
  `@commander-js/extra-typings` are root `devDependencies` because `tooling/` has no manifest of its
  own; `tooling/declared-deps.spec.ts` fails when a file imports commander from a manifest that does
  not declare it, and `omni run check:imports` fails on any import of bare `commander`. `versions.ts` and `release-dry-run.ts` refuse options they do not know (including
  `-x` and `-h`); `release-dry-run.ts --help` prints its usage line, and `versions.ts` prints its
  usage line and exits 2 for `check --foo` or `sync <package> --foo`.
- **Local deploy.** `omni -i run local:deploy -a options=up` (`tooling/local-deploy.ts`; `options=status` and `options=down` are the other
  actions)
  runs the production Compose stack on this machine (Linux, native Docker) under a project named
  `launchpad-local-<8 hex>`, deploys nothing itself, seeds an organization, project and a six-scope key
  through the seed's Compose mode, and `down` removes everything the run created by exact name, never
  with a wildcard or `prune`. It mounts the Docker socket into the worker and Dokku (root-equivalent).
  Its tests use a fake runner, file system and `fetch` (`tooling/local-deploy-fake.ts`); the guide
  ([deploy a site on your machine](local-deploy.md)) is guarded by `tooling/local-deploy-docs.spec.ts`.
  The real-Docker proof is recorded in [the plan](plans/local-deploy-quickstart.md#status).
- **Local dev infrastructure.** `omni -i run dev:infra:up` (`tooling/dev-infra.ts`; `status`, `down`,
  `destroy`, `logs` and `seed` are the other tasks) runs `docker-compose.dev.yaml` (PostgreSQL, Adminer, Mailpit,
  Dokku, the alias router; all on `127.0.0.1`) under a project named `launchpad-dev-<8 hex>` so that
  the controller, worker and CLI run on the host. It writes the host apps' settings to
  `.dev-infra/env/` (git-ignored, mode 700) and never to an app's `.env.local`. `down` keeps the data,
  `destroy` removes everything by exact name through the same ownership-checked teardown as
  `local:deploy`: both tools share `tooling/local-docker.ts`, parameterised by a profile. The file is
  rendered and checked by `tooling/compose-dev.ts` (part of `check:compose`, with the production file's
  Dokku, PostgreSQL and router parts compared to it). The tests use the fake machine of
  `tooling/dev-infra-fake.ts`, and the generated settings must pass the real config parsers; the guide
  ([develop against local infrastructure](local-dev-infra.md)) is guarded by
  `tooling/dev-infra-docs.spec.ts`.
- **Omni loads `.env.local`** from the repository root and the project into task
  environments without expanding variables, and task `env.vars` override the shell. For
  a default that the shell may override, apply it in the command
  (`${TEST_DATABASE_URL:-...}`).
- **Task output** is shown only on failure; `--arg` is `KEY=value` templating for task
  `args:`, not positional passthrough, and piped stdin is not forwarded to a task.

## Stale build output

Omni 0.21.0 restores only missing outputs on a cache hit and does not overwrite an existing
file. A stale, git-ignored `dist/` (for example `apps/cli/dist/index.js`, the name before Vite built the apps, or a `dist/cli.mjs` lacking newer commands)
survives `omni -i run build`, and the cache is shared across checkouts. Run
`omni -i run build -f all`, or delete the project's `dist/` and rebuild.

## CI

`.github/workflows/ci.yaml` and `.github/actions/setup-workspace` are adapted from
Pureform and Omni (provenance, commits and MIT notices: `.github/NOTICE.md`). Jobs only
call `omni -i run ...` (`-i` passes the runner's environment to tasks, `-f=failed`
re-runs previously failed tasks even when cached) and finish with
`omni -i cache prune -sy -o="7d"` to keep the restored cache small. `tooling/ci.spec.ts`
guards the workflow: the gatekeeper must need every other job and always run, its real
script is executed against every pass and fail scenario, and no job may bypass Omni with
a package script. Every workflow except `release.yaml` (and the setup action) is also checked there
for publish, push, tag and login commands, publishing actions and credentials.
`.github/workflows/release.yaml` is the single publishing workflow: `tooling/release.spec.ts`
asserts its trigger, job graph, per-job permissions, `release` environment, absence of caches and
secrets, SHA-pinned actions and the tag guard (it runs the guard step in bash). The release
workflows set up through `.github/actions/setup-workspace`, which owns the Omni and Cocogitto
versions and digests; the release jobs call it with `cache: "false"`. The specs allow that one
local action and still pin every remote action by SHA.
`tooling/release-pr.ts` (the release PR workflow's decisions: input validation, pre-release counter, changelog range, PR body; specs `release-pr-plan.spec.ts` and `release-pr.spec.ts`; `release-pr-sync.spec.ts` runs the sync workflow's step against a fake `gh`), `tooling/release-channels.ts` (the release channel registry, as data, and the channel rules; spec: `release-channels.spec.ts`, which also checks the channels table of `docs/releasing.md`), `tooling/release-core.ts` (pure, dependency-free; spec: `release-plan.spec.ts`), `release-publish.ts` (what the credentialed jobs run: node built-ins only) and `release-plan.ts` hold its decisions: tag guard, npm
dist-tag, floating image tags, partial-release check, `CI Passed` lookup. Run its commands by hand
with `bun tooling/release-plan.ts <command>`; `release:dry-run` takes `-a options=--skip-images`.
Lint the workflow files with
`docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest` after editing them.
**CI installs the released Omni** (pinned in the setup action), which can be older than
a local `cargo install` build of Omni's main branch. The first CI run failed on a preset
without a `name` that the newer local build accepted. Before relying on a local result,
download the pinned release (`omni-v<version>-x86_64-unknown-linux-gnu.zip` from
[omni-oss/omni releases](https://github.com/omni-oss/omni/releases)) and run the CI
commands with it first on the PATH.
**CI also runs Node; this machine does not.** Bun resolves `bun` and ignores package `exports`
restrictions that Node enforces, so a build can pass here and fail in CI (it did twice: the
very first Node build failed on `import "bun"` and on a `package.json` subpath). To check,
run the jobs in a Node container as your own user, e.g. `docker run --rm --network host --user
"$(id -u):$(id -g)" -v "$PWD":/work -v <omni-release-dir>:/omni:ro node:lts-trixie` with
Bun installed (`npm i -g --prefix /tmp/npm bun@<packageManager version>`) and `/omni` on the
PATH; `omni` needs a recent glibc, so Debian bookworm images are too old.
There is no way to run GitHub Actions locally; each job's commands were run against a
pristine checkout instead (no `node_modules`, `.omni` or git-ignored files).

## Agent context

The swe-docs and swe-skills repositories are Git projections pinned in
`workspace.omni.yaml`. Install or restore them with:

```sh
bun run setup:agents
```

Their linked output in `docs/guidelines/` and `.agents/skills/`, along with
Omni's materialized sources in `.omni/`, is ignored. Do not edit those copies.
Change the source revision deliberately when updating them.

## Generate TypeScript projects

The project-owned generator at `omni/generators/ts-package` was copied from
Pureform. Its [README](../omni/generators/ts-package/README.md) records the
upstream commit, license, and adaptations.

Prefer the Omni MCP `generator_run` tool; the CLI equivalent is:

```sh
omni gen run --name ts-package --output packages/my-package \
  --use-defaults --value package_name=my-package \
  --value integration_test=false --save-session=false
bun install
omni -i run check:deps check test build -p @launchpad-kit/my-package
```

Generated files are formatted by the generator, and a generated package passes the
commands above as generated. Add its workspace dependencies to both `package.json`
and `project.omni.yaml`; `check:deps` reports a mismatch.

Use interactive mode (omit `--use-defaults`) to choose library, UI library,
application, Bun script, service tests, or end-to-end tests. Generated files are
committed as editable scaffolding; there is no regeneration step for an existing
package. `release_group=core` registers its glob in the shared core in `cog.toml`;
`binding` or `tooling` registers an independent package; the default `none`
leaves `cog.toml` unchanged. UI/browser
scaffolds require framework-specific setup and Playwright browsers before use.

Shared `tsconfig`, `vite-config`, and `vitest-config` packages support the
generator. The controller customizes its generated app config for TanStack
Start. Library workspace exports resolve to TypeScript source so the controller
bundles them without a prior package build; these packages are private, not
ready-to-publish distributions.

## Commit and release configuration

`cog.toml` is adapted from Pureform at the same commit as the generator. It groups
the existing services/database/Dokku libraries into `core` and registers shared
tooling packages independently. Apps and test projects are not registered.

Cocogitto (`cog`) is available locally. `cog verify "feat: add a preview"` checks
a Conventional Commit message. Install the configured commit-msg hook in each
checkout with `cog install-hook --all`. It validates every commit message and,
when `HEAD` and `origin/main` exist, runs `cog check origin/main..HEAD`, the same range CI
checks, so old history does not block new commits and the first commit on an unborn branch
is supported. Installation does not change Git configuration.

`cog bump` is wired to version synchronization: the `core` group in `cog.toml` lists everything
that ships together (libraries, apps, images and the root manifest), and its
`pre_package_bump_hooks` run `bun tooling/versions.ts sync <package> <version>`, which rewrites the
manifests and refreshes `bun.lock` so the bump commit holds both. `omni -i run check:versions`
(part of `check`) fails when versions disagree or a workspace package is missing from the list.
No hook pushes, and nothing tags or publishes unless you run `cog bump` yourself. See
[releasing](releasing.md) for the rules, the checklist and `omni -i run release:dry-run`, which
rehearses a release into `.release-dry-run/` (also a manual, read-only GitHub workflow).

## Configuration and containers

The controller checks an optional `LAUNCHPAD_APPS_DOMAIN` against `LAUNCHPAD_BASE_URL`
(`assertCurrentSettings`, `packages/services/src/app-routing-config.ts`).

**Implemented (P3c):** `LAUNCHPAD_DEPLOYMENTS=on|off` (default off) and, when on, the apps domain,
limits, TTLs and hostname template (`parseDeploymentConfig`) gate the app, upload and deployment
routes. An enabled worker processes queued deployments and requires the Dokku
proxy origin (`LAUNCHPAD_APPS_PROXY_URL`); see [install](install.md#install-a-private-launchpad-instance-from-built-artifacts).

**Implemented (P4a):** `LAUNCHPAD_ALIASES=on|off` (default off; needs deployments on),
`LAUNCHPAD_MAX_ALIASES_PER_APP` (5), `LAUNCHPAD_MAX_ALIASES` (50) and
`LAUNCHPAD_ALIAS_HOSTNAME_TEMPLATE` (`parseAliasConfig`) gate creating aliases; reading them keeps working while the switch is off. The scopes
`app:promote` and `app:alias:manage` exist.

**Implemented (P4c):** with `LAUNCHPAD_ALIASES=on` the worker also requires the router settings
(`parseAppRoutingConfig`: `LAUNCHPAD_ALIAS_INSTANCE_ID`, `LAUNCHPAD_ALIAS_CONTROL_URL`,
`LAUNCHPAD_ALIAS_PROBE_URL`, `LAUNCHPAD_ALIAS_CONTROL_TOKEN_FILE`,
`LAUNCHPAD_ALIAS_ROUTER_EPOCH_FILE`, `LAUNCHPAD_APPS_PROXY_URL`) and runs queued promotions
through the private router client. The controller exposes promotion, withdrawal, operation reads and app
shutdown (P4d).

**Implemented (P4e):** `launchpad-admin recovery-raise-counters` and a router comparison inside
`recovery-clear`, both reading the router with the same settings the worker uses (see
[restore](restore.md)). Their router client lists routes through the control endpoint and
checks instance and epoch on every page.

**Implemented (P5b):** `launchpad-admin drift` reads two consistent database
snapshots around the external reads and feeds the pure drift comparer. It checks
archives, Dokku's allowlisted `apps:list` / exact-name `domains:report`, and all
router pages (tombstones included); served-identity probes are opt-in. It never
repairs anything or reopens the recovery gate. See [operator usage and exit
statuses](drift.md). `recovery-clear` and `recovery-republish-alias` use the same
inventory readers under the exclusive maintenance lock; see the [restore runbook](restore.md).

**Implemented (P6):** the dashboard, SDK, CLI and MCP use immutable apps, deployments and
separately authorized alias mutations. `launchpad artifact upload`, `launchpad app deploy`
and `launchpad alias promote` are separate commands. `launchpad-admin reconciliation-requests`
shows audit history from recent admin/owner sessions; recording a request does not reconcile
remote state. See [deployment commands](deployments.md).

**Planned, not implemented:** automatic retention expiry or extension after creation.
See [the design](design/deployment-modes.md) and
[routing experiment](decisions/deployment-alias-routing.md). Do not configure those
names against the current binary; the deployment change updates examples, tasks and
this reference together.

The root `docker-compose.env.example` configures the Compose stack. The
controller's settings (PostgreSQL, authentication, email, API docs) are documented
in `apps/controller/README.md` and `apps/controller/.env.local.example`; the worker's settings (database, Dokku SSH, proxy) are in `docs/install.md` step 6 and `apps/worker/.env.local.example`. Do not bake
credentials into an image.

`apps/controller/Dockerfile` and `apps/worker/Dockerfile` are multistage Bun image
recipes, kept beside the app they build (`containers/` is reserved for images of external software, such as
the Dokku image, `containers/dokku/Dockerfile`, which Compose builds with the repository root as context, so the licence files are in it), built from the monorepo root (each has a Dockerfile-specific ignore file that excludes local
env files, state, dependencies and agent context):

```sh
version="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' package.json | head -n 1)"
[ -n "$version" ] || { echo "could not read the version from package.json" >&2; false; }
docker build --build-arg LAUNCHPAD_VERSION="$version" -f apps/controller/Dockerfile -t launchpad/controller:dev .   # needs BuildKit
docker build --build-arg LAUNCHPAD_VERSION="$version" -f apps/worker/Dockerfile -t launchpad/worker:dev .
# The one-off operator image: the controller's program and user plus PostgreSQL 17 client tools.
docker build --target admin --build-arg LAUNCHPAD_VERSION="$version" -f apps/controller/Dockerfile -t launchpad/admin:dev .
# The alias router (not used by the current stack yet; see apps/router/README.md).
docker build --build-arg LAUNCHPAD_VERSION="$version" -f apps/router/Dockerfile -t launchpad/router:dev .
```

Both run as the fixed unprivileged uid 10001, hold no secret (every
setting arrives at run time), and contain no source, env file or key. The controller image has a
healthcheck and carries the operator commands: `bun .output/admin.mjs migrate` (and `setup`,
`backup`, ...). The worker image carries the `docker` and `ssh` clients. Off workers
need no connection settings or data mount; enabled workers need the database, shared
archive mount, Docker engine, and pinned Dokku SSH credentials documented in [install](install.md).
The controller still needs durable storage at `/data`
(a named volume gets the image's ownership; a bind-mounted directory must be owned by 10001:10001).
The base images are pinned by tag and must be pinned by digest before a release. A built artifact's migrations are
bundled into `.output/migrations` (controller); the worker does not run migrations. `backup` and
`restore` need a `pg_dump`/`pg_restore` at least as new as the server, which the image does not
carry: mount one and set `LAUNCHPAD_PG_DUMP` / `LAUNCHPAD_PG_RESTORE`.
The shared `pgEnvironment` adapter preserves the
[documented PostgreSQL client options](backup.md#database-connection-options) and
rejects unsupported or ambiguous query settings; its listener-free regression
tests run with the controller's default unit task.
The router's focused `test:control:tls` task uses OpenSSL-generated fixture CA
and server certificates and loopback listeners, without PostgreSQL or Docker.
Its native control TLS and scoped worker/admin trust are configured by
[the Compose certificate contract](production-compose.md#router-control-certificates).

`omni -i run test:images -p @launchpad-kit/tooling` builds both, checks them (non-root, no secret in a
layer, no `.env`, `.git`, key or source file, the expected files present), runs `migrate` from the
controller image (checking it carries every migration) against the disposable PostgreSQL, starts the controller and waits for `/api/health`
and a healthy healthcheck, and starts the worker with deployments off (it logs `deployment-worker-idle`). It also builds the router image and
checks it end to end: unprivileged, no secret, no published port, `init` from stdin (printing only the
epoch and refusing to reinitialize), healthy, 401 on the control plane and a fixed 404 on the data plane,
a second router refused by the lock, a graceful stop, and `rotate --standalone` after it. Managed
`rotate` uses the promotion database's recovery lock; see the [router guide](../apps/router/README.md).
`init`, `rotate` and
`healthcheck` need the same environment as `serve`, because the settings are validated before any command runs. It needs Docker and
`TEST_DATABASE_URL` (defaults to the disposable fixture), removes its named containers, volumes,
images and database, never pushes, and never touches
Dokku. CI runs it in the integration job. Its containers, anonymous volumes, images and database are
removed by exact name (also on an interrupt); Docker's build cache is not.
`docker-compose.yaml` defines the full stack (including Dokku). The aliases-on,
certificate rotation and recovery drills passed using disposable fixtures, not
production. The fixture preflight and aliases-on baseline have reusable tasks;
the separate rotation, upgrade and recovery modes are not integrated.
See [production Compose](production-compose.md) and the
[follow-up plan](plans/production-compose-follow-up.md).
