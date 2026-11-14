# Tooling

For contributors configuring or extending the scaffold. Keep this page current
when tools, generators, or their commands change.

## Workspace

- Bun 1.4.4 manages `apps/*`, `packages/*`, and future `tests/*` workspaces.
  Dependency versions are centralized in the root catalog and resolved in
  `bun.lock`.
- Omni discovers `project.omni.yaml` files and provides project tasks,
  generators, and pinned Git projections. `omni project list` and
  `omni gen list` inspect discovery.
- TypeScript 7 checks types; `@typescript/typescript6` provides the compiler API
  required by declaration tooling, as in Pureform.
- Vite builds libraries and the controller; Nitro's `bun` preset emits the
  controller's `.output/`. No custom HTTP/static-file server is maintained.
- Vitest, Oxfmt, and Oxlint provide tests, formatting, and linting. Commands are
  in [CONTRIBUTING.md](../CONTRIBUTING.md).

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

```sh
omni gen run --name ts-package --output packages/my-package \
  --use-defaults --value package_name=my-package \
  --value integration_test=false --save-session=false
bun install
```

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
controller's future runtime placeholders are separately documented in
`apps/controller/.env.local.example`; they are not wired to PostgreSQL or SSH
yet. Do not bake credentials into an image.

`apps/controller/Dockerfile` is a multistage Bun image recipe, built from the
monorepo root. Its Dockerfile-specific ignore file excludes local env files,
state, dependencies, and agent context, overriding the root Dokku build ignore
file. The runtime runs as `bun` and gets no Docker socket.

Image building and runtime startup are intentionally deferred. When authorized:

```sh
docker build -f apps/controller/Dockerfile -t launchpad/controller:dev .
```

The recipe has not been container-built or runtime-tested. `docker-compose.yml`
still manages Dokku only; controller/PostgreSQL orchestration and secure
controller-to-Dokku networking remain future work.
