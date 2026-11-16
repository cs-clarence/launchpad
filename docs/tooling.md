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
  `omni -i run build -p @launchpad/mcp`; it emits `apps/mcp/dist/index.js`.
  MCP uses the official MIT-licensed `@modelcontextprotocol/sdk` (pinned in the
  catalog at 1.32.2) for stdio framing, capability negotiation and tool schemas,
  not a custom protocol implementation. Only stdio modules are imported.
- Vitest, Oxfmt, and Oxlint provide tests, formatting, and linting. Commands are
  in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Omni tasks

Every project extends a preset in `omni/presets` (all of them extend `ts.omni.yaml`),
which defines the shared tasks: `build`, `check:types`, `check:lint`, `check:format`,
`check`, `test:unit`, `test:integration` and `test`. The `tooling/` project holds
repository-wide tasks that belong to no package (whole-repo format, tooling types and
lint, `check:deps`, `check:compose`, `test:db:up`/`down`, and tests of this tooling).

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
- **`test` is unit tests only.** `test:integration` is explicit. Auth, services and
  controller integration need disposable PostgreSQL (`omni -i run test:db:up`).
  The SDK's integration suite only uses ephemeral loopback HTTP fixtures; run it
  alone with `omni -i run test:integration -p @launchpad/sdk`. No database is needed.
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
omni -i run check:deps check test build -p @launchpad/my-package
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

Do not use `cog bump` for releases yet: Pureform's version-update helper was not
copied, and manifest/lockfile version synchronization is not implemented. No
automatic push hooks are configured.

## Configuration and containers

Root `.env.local.example` configures the existing Dokku Compose setup. The
controller's settings (PostgreSQL, authentication, email, API docs) are documented
in `apps/controller/README.md` and `apps/controller/.env.local.example`; SSH to Dokku is not wired yet. Do not bake
credentials into an image.

`apps/controller/Dockerfile` is a multistage Bun image recipe, built from the
monorepo root. Its Dockerfile-specific ignore file excludes local env files,
state, dependencies, and agent context, overriding the root Dokku build ignore
file. The runtime runs as `bun` and gets no Docker socket.

Image building and runtime startup are intentionally deferred. When authorized:

```sh
docker build -f apps/controller/Dockerfile -t launchpad/controller:dev .
```

The recipe has not been container-built or runtime-tested with the current
controller. It ships only the built server: the operator commands (`migrate`,
`setup`) and the migration files run from a source checkout until milestone 6
packages them. `docker-compose.yml`
still manages Dokku only; controller/PostgreSQL orchestration and secure
controller-to-Dokku networking remain future work.
