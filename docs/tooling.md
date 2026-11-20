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
- The CLI and the separate local MCP app use Bun executable builds. Build MCP with
  `omni -i run build -p @launchpad-kit/mcp`; it emits `apps/mcp/dist/index.js`.
  MCP uses the official MIT-licensed `@modelcontextprotocol/sdk` (pinned in the
  catalog at 1.32.2) for stdio framing, capability negotiation and tool schemas,
  not a custom protocol implementation. Only stdio modules are imported.
  The controller's integration tests build the MCP and CLI first and run their built
  files (also copied alone into an empty directory) over stdio against the built controller.
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
- **Packaging.** `omni -i run test:packages -p @launchpad-kit/tooling` builds the SDK, contracts, CLI and
  MCP server, packs them (`tooling/package-clients.ts`: a generated manifest per package, the SDK
  and contracts as libraries, the CLI and MCP as one bundled file each), installs the tarballs in a
  clean project outside the workspace and runs them under Bun and, when it is on the PATH, Node
  (CLI and MCP `--help`, an MCP handshake, an SDK call against a local server, and a strict
  TypeScript check of the declarations). It also checks the tarballs hold no `.env`, source, tests
  or `workspace:`/`catalog:` specifiers. It needs the network and publishes nothing; the package
  names are placeholders until the product name is decided. CI runs it as the `Packages` job.
- **`test` is unit tests only.** `test:integration` is explicit. Auth, services and
  controller integration need disposable PostgreSQL (`omni -i run test:db:up`).
  The SDK's integration suite only uses ephemeral loopback HTTP fixtures; run it
  alone with `omni -i run test:integration -p @launchpad-kit/sdk`. No database is needed.
- **Upgrade drill.** `omni -i run test:upgrade -p @launchpad-kit/controller` builds a
  disposable controller image, runs its `migrate` command and exercises the built
  admin's backup/restore and starts/restarts the image server against the frozen
  `apps/controller/src/admin/__tests__/fixtures/schema-014.dump` (14 migrations,
  synthetic user), on disposable PostgreSQL only. It backs up, migrates,
  restarts, checks schema status and restores a fresh database. It is also in
  `test:integration`; no Dokku is touched. The complete operator procedure and
  restore procedure are in [restore](restore.md), with
  [installation](install.md), [upgrade](upgrade.md) and [routing](access.md).
- **Migration 018 model/reservations.**
  `omni -i run test:deployment-schema -p @launchpad-kit/controller` exercises the real
  discovered migration, populated 014/017 upgrades and rollback/refusal. It tests
  organization/app-qualified FKs, permanent identity registries, deferred
  reciprocal ownership, immutable intents and concurrent cross-kind hostname
  reservation. It uses ordinary invoker validators, not a separate model SQL fixture.
  It requires disposable PostgreSQL and is uncached. Legacy P1 candidate,
  inventory and old-process tasks are removed. Services integration covers the
  recovery gate; controller integration covers marker persistence, older-dump
  restore over model rows and post-018 round trips. See [restore](restore.md).
- **Disposable routing experiment.** The opt-in `test:routing:experiment` tooling task
  builds a worker image, deploys two fixtures through pinned SSH to its own Dokku,
  and exercises the experimental generation-checked Bun/SQLite router. It has no
  default/CI dependency and needs `LAUNCHPAD_ROUTING_EXPERIMENT=1` plus explicit
  approval to start disposable infrastructure. Child commands use minimal
  environments rather than production `.env.local` settings. Resource inventory,
  cleanup scope, evidence and limitations are in
  [the experiment record](plans/routing-experiment-evidence.md).
- **Omni loads `.env.local`** from the repository root and the project into task
  environments without expanding variables, and task `env.vars` override the shell. For
  a default that the shell may override, apply it in the command
  (`${TEST_DATABASE_URL:-...}`).
- **Task output** is shown only on failure; `--arg` is `KEY=value` templating for task
  `args:`, not positional passthrough, and piped stdin is not forwarded to a task.

## CI

`.github/workflows/ci.yaml` and `.github/actions/setup-workspace` are adapted from
Pureform and Omni (provenance, commits and MIT notices: `.github/NOTICE.md`). Jobs only
call `omni -i run ...` (`-i` passes the runner's environment to tasks, `-f=failed`
re-runs previously failed tasks even when cached) and finish with
`omni -i cache prune -sy -o="7d"` to keep the restored cache small. `tooling/ci.spec.ts`
guards the workflow: the gatekeeper must need every other job and always run, its real
script is executed against every pass and fail scenario, and no job may bypass Omni with
a package script. Lint the workflow files with
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
checkout with `cog install-hook --all`. It validates every commit message and
runs `cog check` when `HEAD` exists, so the first commit on an unborn branch
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

**Implemented:** the controller and worker refuse to start while a removed preview
setting is set (`LAUNCHPAD_PREVIEW_DOMAIN`, `LAUNCHPAD_PREVIEW_PROXY_URL`,
`LAUNCHPAD_MAX_PREVIEWS`, `LAUNCHPAD_ALLOW_NO_EXPIRY`, `LAUNCHPAD_LIFECYCLE*`), and
the controller also checks an optional `LAUNCHPAD_APPS_DOMAIN` against `LAUNCHPAD_BASE_URL`
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

**Planned, not implemented:** automatic retention expiry.
See [the design](design/deployment-modes.md) and
[routing experiment](decisions/deployment-alias-routing.md). Do not configure those
names against the current binary; the deployment change updates examples, tasks and
this reference together.

Root `.env.local.example` configures the existing Dokku Compose setup. The
controller's settings (PostgreSQL, authentication, email, API docs) are documented
in `apps/controller/README.md` and `apps/controller/.env.local.example`; the worker's settings (database, Dokku SSH, proxy) are in `docs/install.md` step 6 and `apps/worker/.env.local.example`. Do not bake
credentials into an image.

`apps/controller/Dockerfile` and `apps/worker/Dockerfile` are multistage Bun image
recipes, kept beside the app they build (`containers/` is reserved for images of external software, such as
the Dokku image, `containers/dokku/Dockerfile`, which Compose builds from its own directory), built from the monorepo root (each has a Dockerfile-specific ignore file that excludes local
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

`omni -i run test:images -p @launchpad-kit/tooling` builds both, checks them (non-root, no secret in a
layer, no `.env`, `.git`, key or source file, the expected files present), runs `migrate` from the
controller image against the disposable PostgreSQL, starts the controller and waits for `/api/health`
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
removed by exact name (also on an interrupt); Docker's build cache is not. `docker-compose.yml` still manages Dokku only;
controller/PostgreSQL orchestration and secure controller-to-Dokku networking remain future work
(`docs/plans/production-compose-follow-up.md`).
