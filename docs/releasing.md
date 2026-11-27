# Releasing Launchpad

For a maintainer preparing a release. **Nothing in this repository publishes, pushes,
tags or releases by itself.** The rehearsal below is read-only; real publishing needs a
separate, explicit authorization and a workflow that does not exist yet. The
[release publishing decision](decisions/release-publishing.md) defines the one gated workflow
that may publish. This sentence is revisited when that workflow lands.

## Versions

One version covers everything that ships together: the root manifest, every package under
`packages/` and `apps/` (including the controller and worker images, which carry the same
number), except the shared tooling packages (`@launchpad-kit/tsconfig`, `vite-config`,
`vitest-config`), which are versioned on their own. `cog.toml` is the source of truth: the
`core` group lists what ships together, and every package registered by name is independent.

- `omni -i run check:versions` (part of `check`, so part of CI) fails when two shipped
  packages disagree, a version is not valid SemVer, or a workspace package is missing from
  the `core` include list, which would mean its changes never cause a bump.
- `bun tooling/versions.ts sync <core|package> <version>` rewrites the manifests and
  refreshes `bun.lock`. You do not run it by hand: Cocogitto's `pre_package_bump_hook` in
  `cog.toml` does, so the bump commit holds manifests, lockfile and changelog together.
- The hook was proven in a throwaway clone: `cog bump --auto --package core` produced one
  commit with every manifest, `bun.lock` and `CHANGELOG.md`, and the tag `core-v<version>`.
  Run `cog bump` only on a clean checkout of the commit you mean to release, review the
  result, and **do not push** the commit or tag until the release is authorized. The commit
  message carries `[skip ci]`, so CI will not check it: run the local checks before bumping **and**
  again on the bump commit (checklist step 7). The [release publishing decision](decisions/release-publishing.md#bump-commit-and-ci) changes this: the bump will go through a release pull request with CI, in a later slice.
- Three version strings are written in source (the CLI's `--version`, the MCP server info and
  the OpenAPI `info.version`); `sync core` rewrites them and `check:versions` compares them.
- `from_latest_tag = false`: with no earlier tag the first changelog covers all history.
  Tag a baseline first if that is not wanted.

## What a release contains

| Artifact                                                                | Built by                                     | Checked by                         |
| ----------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------- |
| `@launchpad-kit/contracts`, `sdk`, `client-core`, `cli`, `mcp` tarballs | `tooling/package-clients.ts`                 | `test:packages`, the dry run       |
| Controller, worker, operator (admin) and router images                  | `apps/{controller,worker,router}/Dockerfile` | `test:images`, the dry run (build) |
| Database migrations (forward-only, bundled in the images)               | `packages/database/src/migrations`           | `test:integration`, `test:upgrade` |
| Operator documentation                                                  | `docs/`                                      | review                             |

The workspace scope is `@launchpad-kit`, selected on 2026-11-19. Registry ownership
and availability have **not** been verified, and no package has been published.
The licence is Apache-2.0 (root `LICENSE`). Every packed tarball carries `LICENSE` and a
manifest `license` of `Apache-2.0`, and the package checks refuse one that does not. Packed
READMEs are still developer documentation. The repository is
<https://github.com/launchpad-kit/launchpad> (transferred 2026-11-27) and every packed manifest
carries `repository` (`type`, the exact URL `git+https://github.com/launchpad-kit/launchpad.git`
and the package's `directory`), `homepage` (the repository README) and `bugs` (its issues). `stage()`
builds these from the one constant `REPOSITORY_URL` in `tooling/package-clients.ts` because the pack
writes a new manifest and does not copy the source one; npm trusted publishing requires
`repository.url` to match the GitHub repository exactly. `checkManifest` refuses a packed
manifest whose fields differ, and `check-packages.ts` does the same for the source manifests. The
final product naming remains a release gate.
A package is packed only if it is in `TARGETS` in `tooling/package-clients.ts`; that is also
where it gets its `LICENSE` (the root file is copied in), so a generated package needs no
`LICENSE` of its own.

## The npm packages stay runtime agnostic

`@launchpad-kit/contracts`, `sdk`, `client-core`, `cli` and `mcp` are the five published npm
packages, and none of them bundles a dependency: each declares what it imports and the registry
installs it. They must run on Node (engines `>=22.12`) as well as
Bun, so their `src` may not use a Bun-only API: the `Bun` global, `globalThis.Bun`, `"bun"` or
`"bun:*"` imports, `process.versions.bun`, and any `import.meta` member other than `url`,
`dirname`, `filename` and `resolve` (so `dir`, `file`, `path`, `require` and `main`, which Node
only has from 24.2, are rejected). Code bundled into the Docker images
(controller, worker, router, database, services, ...) may use Bun APIs freely.

Two gates enforce it:

- `omni -i run check:runtime` (part of `check`) scans those packages' `src`, ignoring
  `*.spec.ts` and `__tests__`, and fails with `file:line`. The package list comes from
  `TARGETS` in `tooling/package-clients.ts` (`tooling/runtime-agnostic.ts`).
  It parses each file with TypeScript 6 and leans towards false alarms. It flags: any `Bun`
  identifier or `.Bun` property access, whatever the receiver (only a declared key or member
  such as `{ Bun: 1 }` or `interface { Bun: string }` is harmless); any `.bun` access or
  destructured `bun`; any string that is exactly `bun`, `Bun` or starts with `bun:`;
  `globalThis`, `global`, `window` or `self` used as a value (allowed: as the receiver of a
  named member or a string key, under `typeof`, and as the argument of `.bind(globalThis)`) or
  with a computed key; `process.versions` read other than `.node`; `import.meta` members
  other than `url`, `dirname`, `filename` and `resolve`; `createRequire`, `.require`, and
  `require` not called with a string literal; `eval`, `Function` and `.constructor(...)` calls;
  a dynamic `import()` or `require()` whose specifier is not a plain string. A file that does
  not parse, a broken symbolic link, or a `src` with no source file fails; linked files and
  directories are scanned. Spec files and `__tests__` are skipped because they are not
  published (`tooling/package-clients.ts` admits only built `.mjs` and `.d.ts` files and rejects
  `*.spec.*` and `__tests__/`). This is a guardrail against accidents, not a defence against
  deliberate evasion (a computed key on an aliased object, say, is not caught): the packages'
  `@types/node` typings and the Node smoke test are the other layers. A real need for one of
  these in a published package means changing the rule here, in review.
- `test:packages` installs the packed tarballs outside the workspace twice, with Bun and with the
  real `npm` that ships with the selected Node, and runs them under Bun **and** Node:
  `--version`, `--help`, importing `contracts` and `sdk`, an SDK call, a `client-core` credential
  store read, an MCP handshake and the installed `bin` links. The npm install makes the five
  owned packages direct `file:` dependencies pinned by `$name` overrides (so npm never looks one
  up by name), points the `@launchpad-kit` scope at a dead address, allows 120 seconds and checks
  the installed manifests, the lockfile (`resolved` is the local tarball, `integrity` its SHA-512),
  `npm ls --all --json` and that each package is installed once. Choose the Node with `LAUNCHPAD_NODE=/path/to/node`
  (default: `node` on the `PATH`). Without Node the Node runs are skipped with a message
  locally and fail when `CI` is set. CI runs the job on Node 22.12 and the current release.
  Only the runs of the packed files use that Node: the builds run under Bun (`bun --bun run
  build`), so they do not depend on it (Node before 22.18 cannot load the TypeScript vite config).

## No published package bundles its dependencies

The CLI and the MCP server are built with Vite (`vite build`, preset `ts-vite-script`) into one
ES module each, `dist/cli.mjs` and `dist/mcp.mjs`, that imports every declared dependency
(`@launchpad-kit/*` included) instead of inlining it. The `#!/usr/bin/env node` line is in
`src/index.ts` and survives the build; staging copies the built file unchanged and makes it
executable, and fails if line 1 is not that shebang. Running the source with Bun ignores the
line. `package-clients.ts` packs a generated manifest per package (the source manifests stay
private), and three gates run on every tarball, in `test:packages` and the dry run:

- **Closure** (`checkClosure`): no `workspace:`, `catalog:`, `file:`, `link:`, git or URL
  specifier in any dependency section; no `bundledDependencies`, `publishConfig`, `scripts`,
  `workspaces` or `overrides`; all five carry one version and refer to each other as
  `^<that version>`; a third-party package has one range across the five.
- **Bare imports** (`checkBareImports`): every bare specifier in a `.mjs` or `.d.ts` is a
  Node module or a dependency the package declares.
- **No inlining** (`checkUnbundled`): a size budget per executable (cli 79 kB, mcp 11 kB: the
  measured size plus 25 %, rounded up to the next kB; raise the pinned measured size
  (`MEASURED_SIZES` in `tooling/package-clients.ts`) in review when growth is real) and a marker
  string of every dependency that must be absent from the other packages' files.
  `tooling/vite-config.spec.ts` checks the apps' build config externalizes dependencies and emits `cli.mjs`/`mcp.mjs`.

Source manifests reference every owned package as `workspace:^` (`check:deps` requires exactly
that). Packing writes `^<version>`, so in `0.x` an install may differ from the others by a patch
only; a fix in `client-core` reaches an installed CLI when npm next resolves it. A development
`dist/cli.mjs` needs `omni -i run build`; an old `dist/index.js` may remain beside it (see
[Stale build output](tooling.md#stale-build-output)). The generator rule is in
`omni/generators/ts-package/README.md`. Windows is not supported (`client-core` checks file
modes and owners on POSIX only) and untested. The decision is
[npm apps do not bundle](decisions/npm-apps-do-not-bundle.md).

The `client-core` pre-publish review is done for the blockers (named public API, redaction of
the run's secrets, the security model in its README, the packed-file checks). The remaining
audit findings are a non-blocking follow-up list. Nothing here publishes anything.

The five packages use `@types/node`, not `@types/bun`; tests still run under Bun.

## Rehearse a release

```sh
omni -i run release:dry-run -p @launchpad-kit/tooling
```

or run the manual **Release dry run** workflow. It checks that versions agree, packs the
five client packages with the same allowlist, closure and no-bundling checks as `test:packages`
(the Node and npm smoke runs in `test:packages`, not in the dry run), writes
`packages/SHA256SUMS`, builds both images **without pushing them**, removes those images by
exact name (Docker's build cache and pulled base images stay), and leaves everything in `.release-dry-run/` (kept 7 days as a workflow
artifact). The workflow has read-only permissions, no secret and no write token, and a test
(`tooling/ci.spec.ts`) fails if it ever gains a trigger other than manual dispatch, a
secret, or a publish, push, tag or login command. Verify the checksums with
`cd .release-dry-run/packages && sha256sum -c SHA256SUMS`.

## Compatibility rules

A release number tells users what they can rely on. While the version is `0.x`, minor
versions may contain breaking changes, but every one is listed in the changelog under a
breaking-change heading. From `1.0.0`: a breaking change needs a major version.

**REST API** (`/api/v1`, described by `/api/openapi/json`). Compatible: a new route, a new
optional request field, a new response field, a new enum value in a response a client must
already tolerate, a new error code on a new path. **Breaking**: removing or renaming a
route, field or enum value; making an optional input required; changing a type, a status
code or an error code a client may branch on; tightening a limit or a validation rule so a
previously valid request fails; changing the meaning of a role or key scope, or
authenticating a route more strictly. A breaking change ships under a new path prefix
(`/api/v2`) with `v1` kept for one major version.

**SDK and contracts** (`@launchpad-kit/sdk`, `@launchpad-kit/contracts`). The exported names, their
types and the schemas' accepted and produced shapes are the interface. Breaking: removing
or renaming an export, narrowing a parameter type, widening a returned type a caller
narrows on, changing an error class a caller catches. Adding exports and optional fields is
compatible. A change to a schema that the REST API uses follows the REST rule too.

**client-core** (`@launchpad-kit/client-core`). A public package for the CLI and the MCP
server; other users should use `@launchpad-kit/sdk`. Its interface is the list in the
[README's Public API](../packages/client-core/README.md#public-api). Names marked `@internal`
(`resolve`, `clientFor`, `Resolved`) may change in any release. Under `0.x` a minor release may
break the public interface and lists the change under a breaking-change heading; a patch never
does. The files it writes, `credentials.json` and `session.json`, are format `version: 1`: a
client that meets another version refuses it and never rewrites it. A format change needs a
reader for the previous version for at least one minor release, plus a changelog note (the CLI
and the MCP server share the files). It supports POSIX only and Node `>=22.12`. A change that
narrows redaction, loosens a mode or owner check or the HTTPS-or-loopback rule, or widens what
`packDirectory` includes is security-relevant: it needs its own review and a release note. All
five packages carry one version and refer to each other as `^<version>`; in `0.x` that allows
patch differences only, and from `1.0.0` minors, which these rules already treat as compatible.

**MCP tool list** (`apps/mcp/src/server.ts`). Tool names, their input schemas and the shape
of their results are the interface an agent depends on. Breaking: renaming or removing a
tool, removing or retyping an input or a result field, making an input required, or changing
what a tool is allowed to do (the default tool set is read-only; mutations stay opt-in). New tools and new optional inputs are compatible. Any new
mutating tool is a **security-relevant** change: it needs its own review and release note.

**CLI** (`launchpad`). Command names, flags, exit codes and the documented output of
`--json` modes are the interface; human-readable text is not. Breaking: removing or renaming
a command or flag, changing an exit code or a machine-readable field. Credentials are never
accepted as arguments; that does not change.

**Database and operator commands.** Migrations are forward-only and run only by
`bun .output/admin.mjs migrate`; rollback means restoring the pre-upgrade backup. A release
must upgrade from the previous supported release’s schema. The first v1 release uses a fresh database.
Breaking: a migration that cannot run on the previous release's data, a changed backup
manifest format without reading the old one, a renamed or removed admin command or option, a
changed configuration variable name or meaning, or a change to the fixed uid, data
directory layout or required mounts of the images. State each in the upgrade notes.

## Release checklist

A release is a person's decision. Work through this in order and stop at the first failure.

1. `main` is green: `CI Passed`, and the full local gate
   `omni -i run check test build check:compose test:integration --force all`
   plus `omni -i run test:upgrade -p @launchpad-kit/controller` on Linux.
2. The initialization/restore drill passes; rehearse upgrade from any previous supported schema; `docs/upgrade.md` and `docs/restore.md` match the commands.
3. Every breaking change since the last release is listed against the rules above, and the
   version increment fits them. Security-relevant changes have a release note.
4. Licence, npm scope and product name are decided and recorded; the packed READMEs and
   manifests carry `license` and `repository`; **registry ownership of the name is verified
   with an authenticated account**. (Done: the licence, Apache-2.0, and the repository
   metadata. Remaining: the user verifies ownership of the npm organization for the
   `@launchpad-kit` scope, the package names are confirmed available, trusted publishers
   are configured for them, and the final product naming is settled.)
5. Base images in `apps/{controller,worker,router}/Dockerfile` and `containers/dokku/Dockerfile`, and
   `postgres` in `docker-compose.yaml`, are pinned by tag **and** digest (asserted by
   `check:compose`; digests are verified with `docker buildx imagetools inspect`, see
   [production Compose](production-compose.md#images-and-pins)). Refresh them deliberately.
6. Run the [dry run](#rehearse-a-release); inspect the tarball listings, `SHA256SUMS` and the
   image notes. No `.env`, key, source map or workspace specifier in any tarball.
7. `cog bump` on a clean checkout, then review the bump commit, changelog and tag locally.
   The bump commit rewrites manifests, source version strings and `bun.lock` and carries
   `[skip ci]`, so CI does **not** validate it: on that commit rerun step 1's local gate and
   step 6's dry run, and use the checksums from **that** run. The ones from before the bump
   are for a different version.
8. Obtain explicit authorization to publish. Publishing uses a least-privilege identity,
   provenance attestation, and pinned image tags and digests; it is a separate workflow
   written and reviewed for that purpose, and it is not part of this repository yet.
9. After publishing: install the published packages in a clean project on Node and Bun
   (`omni -i run test:packages` does this from tarballs), and keep the previous version's
   artifacts available for rollback.

Rolling back a published package is not possible: an npm version cannot be unpublished
safely once used, so a bad release is superseded by a fixed one and the bad version is
deprecated. An image tag is never reused. Data is protected by the backup that the upgrade
procedure requires first.
