# Releasing Launchpad

For a maintainer preparing a release. **Only one workflow publishes:**
`.github/workflows/release.yaml`, described in the
[release publishing decision](decisions/release-publishing.md). It runs when a maintainer pushes a
`v<semver>` tag (never on a pull request, a schedule or by hand), each publishing job (`stage`,
`npm-publish`, `image-publish`) waits for approval of the `release` environment, and it has **not
run yet**. Nothing else in the repository publishes, pushes, creates **release** tags or releases;
the release-PR sync writes transient internal `release-sync-retry/` markers when a recovery fails.
The rehearsal below
is read-only. The state of the first
release, what remains and the decisions still open are in the
[0.1.0 plan](plans/release-0.1.0.md); its draft notes are in [release notes 0.1.0](release-notes/0.1.0.md).

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
- **Bump only with `cog bump --version X.Y.Z --include-packages`.** `cog bump --auto` after a
  tooling-only change (for example a `fix:` under `packages/tsconfig`) makes a changelog-only
  bump and tag `v0.1.1` without `sync core`, leaving the manifests at the old version.
  Plain `--version X.Y.Z` does the same. `check:versions` fails when a `v` tag is newer than the
  manifests (full SemVer precedence; skipped when there is no git or repository, a failed tag query fails the check). The explicit form also sets the three tooling packages to `X.Y.Z`.
- The hook was proven in a throwaway clone: `cog bump --version 0.2.0 --include-packages` produced one
  commit with every manifest, `bun.lock` and `CHANGELOG.md`, and the global tag `v<version>`
  (`cog.toml` sets `generate_mono_repository_global_tag = true`, package tags off; in the clone the only tag was `v0.1.0`).
  Run `cog bump` only on a clean checkout of the commit you mean to release, review the
  result, and **do not push** the commit or tag until the release is authorized. `skip_ci` is
  empty, so the bump commit does not carry `[skip ci]` and CI runs on it. Per the
  [release publishing decision](decisions/release-publishing.md#bump-commit-and-ci) the bump
  goes through a release pull request; the tag `v<semver>` is created on the merge commit.
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

Images are published as `ghcr.io/launchpad-kit/launchpad-<name>` (`controller`, `worker`,
`router`, `admin`, `dokku`; the Dokku image is built from `containers/dokku/Dockerfile` with the
repository root as context). Each carries the OCI labels `title`, `description`, `source`, `url`,
`documentation`, `licenses` (`Apache-2.0`), `version`, `revision` and `created`: `version` comes
from the `LAUNCHPAD_VERSION` build argument (the label the
[release record](decisions/release-publishing.md) reads to order `X.Y` and `latest`), `revision`
and `created` from `LAUNCHPAD_REVISION` and `LAUNCHPAD_CREATED`. A local build leaves them
`unknown` or empty. They also hold `/licenses/LICENSE` and `/licenses/THIRD_PARTY_NOTICES.md`
(generated by `bun tooling/third-party-notices.ts` from the installed packages, and `check:notices`, part of `check`, fails when the committed file is stale; it lists declared
licences and notes Bun's JavaScriptCore (LGPL) and the Debian, Docker CLI and Dokku bases).
`check:compose` asserts the labels and the licence copy in every published Dockerfile stage.
`docker-compose.yaml` requires `LAUNCHPAD_IMAGE_TAG` and has no `latest` default.

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
7. (Done by the [release PR workflow](#opening-the-release-pr); the manual fallback is)
   `cog bump --version X.Y.Z --include-packages` on a clean checkout, then review the bump commit, changelog and tag locally.
   The bump commit rewrites manifests and `bun.lock` (the programs read their version from their own manifest), and does not
   carry `[skip ci]`, so CI validates it. On that commit rerun step 6's dry run and use the
   checksums from **that** run. The ones from before the bump
   are for a different version.
8. Obtain explicit authorization to publish, then (after the maintainer steps in the decision
   record are done) merge the release pull request and, on the merge commit on `main` after its
   `CI Passed` is green, create and push the one tag `v<semver>` by hand (delete the local
   Cocogitto tag first; push tags one at a time). The workflow then runs; approve each `release`
   job (see below).
9. After publishing: install the published packages in a clean project on Node and Bun
   (`omni -i run test:packages` does this from tarballs), and keep the previous version's
   artifacts available for rollback.

Rolling back a published package is not possible: an npm version cannot be unpublished
safely once used, so a bad release is superseded by a fixed one and the bad version is
deprecated. An image tag is never reused. Data is protected by the backup that the upgrade
procedure requires first.

## Opening the release PR

`.github/workflows/release-pr.yaml` does the mechanical part of the checklist's step 7. In
Actions, run **Release PR** from `main` (it fails on any other ref) with the base version `X.Y.Z`
and a channel (`stable` or `rc`, the rows of the registry below). It never tags and never
publishes. Three jobs:

1. `prepare` (read-only; runs `bun install`, Cocogitto and its hooks): validates the inputs with the
   registry (the kind of release comes from the base and the channel must support it), computes the
   pre-release number from the existing `v<base>-<channel>.*` tags, refuses a stable `X.Y.Z` that
   exists or a version that would go backwards across channels, cuts `release/<version>`, runs
   `cog bump --version <version> --include-packages` and `check:versions`, checks the commit message
   and the title with `cog verify`, and writes the PR body from `cog changelog` (a stable release
   since the last stable tag, a pre-release since the previous tag of any kind). It hands over only
   data: a git bundle of the one bump commit and the body.
2. `push` (`contents: write`; runs no repository code): validates the bundle: one ref; one commit
   directly on `main` whose object is exactly tree, that parent, author, committer and the fixed
   message (no signature or other header, nothing after the message); only allowlisted paths
   (`package.json` and `CHANGELOG.md` files one level below `apps/` or `packages/` with
   `[a-z0-9-]` directory names, the root ones and `bun.lock`), as plain files, none larger than 2 MiB
   (about ten times the lockfile, far above a changelog that gains one release per section, but
   finite); and a manifest or `bun.lock`
   source file changing only on its version line, which must carry this version (a new manifest
   is refused). Every blob is read with `git cat-file` and compared with `diff`, and a failing
   command stops the job. It then checks that `release/<version>` does not exist and pushes
   **only** `<validated commit>:refs/heads/release/<version>`; the data is never checked out.
3. `open-pr` (`pull-requests: write`; runs no repository code): opens the PR
   `chore(release): v<version>`.

Then you approve the PR's pending workflow run (**Approve workflows to run** in the merge box: a
PR opened with the workflow token starts its run in the approval-required state), review the PR,
wait for `CI Passed`, merge, and create the one tag `v<version>` by hand on the merge commit as in
step 8; the tag starts the release workflow. The manual steps of the checklist (step 7) remain the
fallback.

**The PR body** (the changelog text, so mentions and closing keywords) comes from the `prepare`
job and is accepted as it is, cut at 60,000 bytes by the tooling and refused above 65,000 bytes
by `open-pr`; treat it as text to read, not as instructions. `open-pr` holds only
`pull-requests: write`: `gh pr create` uses GraphQL, and the REST page for creating a pull request
names no further permission, so `pull-requests: write` is expected to suffice, which is unverified
(add `contents: read` if it does not).

**What to check in the PR.** The workflow validates the paths, but you are the reviewer: confirm
that the diff touches only versions, the lockfile and changelogs (it should read as a version bump
and generated changelog text, nothing else).

**If `main` moves while the PR is open.** Do not merge `main` into it: the bump commit's changelog
and version lines were generated from the old tip. `.github/workflows/release-pr-sync.yaml` watches
pushes to `main` and runs every five minutes; for an open `release/<version>` PR
whose bump commit no longer sits directly on the live tip, it closes the PR with a note, deletes the
branch and dispatches Release PR again for the same base and channel. Closing first matters: deleting
the head branch would close the PR itself. That regenerates everything
from the new tip, so expect a new PR number and merge that one. The five-minute run also catches a
push that lands while Release PR is preparing a replacement (GitHub can delay a scheduled run, so
this is not immediate). The run writes a `release-sync-retry/<version>` marker before it changes
anything; if that write fails it leaves the PR untouched. It then closes the PR, deletes the branch
and dispatches, removing the marker only after the dispatch is accepted. A failed close or delete
keeps the marker; a failed dispatch is retried once, then restores the branch and reopens the PR,
still keeping the marker. Those recoveries are checked and the run fails with the exact commands if
one cannot be done. A later run drains any marker (free the branch, dispatch, remove the marker
after the dispatch is accepted), so a closed PR cannot lose the retry. Its step
is executed in `tooling/release-pr-sync.spec.ts` against a fake `gh`; it runs no repository code and
never publishes. Its only tags are internal `release-sync-retry/` markers for a failed recovery.

**Maintainer settings.** (1) **Settings, Actions, General, "Allow GitHub Actions to create and
approve pull requests"** must be on, or `gh pr create` fails; only the `open-pr` job, which runs no
untrusted code, uses it. (2) Recommended: the `release-pr` environment (created on first use) with
its deployment branch policy limited to `main`, and **no required reviewers** beyond that (a
maintainer decision): `push` and `open-pr` each declare `environment: release-pr`, so a configured
reviewer would have to approve twice per run. GitHub runs the workflow file from the branch it is
dispatched on, so a branch with an edited `release-pr.yaml` is the trust boundary. The policy binds
only jobs that still reference the environment: while they do, the two jobs that hold write scopes
cannot run from another branch, but a dispatched file that drops `environment:` is outside it, so
trust in who may dispatch, and in reviewed workflow changes, remains part of the boundary.

**When it goes wrong.** If a run stops after the push, or the PR was closed without merging,
delete the branch `release/<version>` and dispatch again (the workflow refuses an existing
branch). A base lower than the latest tag (for example 1.5.0 when `v2.0.0-rc.1` exists) is
accepted on purpose, for backports; the registry rules still apply.

A PR opened with the workflow token starts its `pull_request` run in the approval-required state;
you start it with **Approve workflows to run**, and that run's `CI Passed` is the merge gate. The
workflow no longer dispatches CI: a `workflow_dispatch` run is not a required status check the
ruleset honours (unverified, but the reason the dispatch and its `actions: write` were removed), and
the approval click is needed either way. A compromised `prepare` job can write Actions cache
entries scoped to `main`; this is accepted, as `ci.yaml` already does the same.

## Release channels

The channels a release can use are rows of a registry, `tooling/release-channels.ts`, which is the
source of truth for the guard, the npm tag, the image tags and the promotion order. The table below
is checked against it by `tooling/release-channels.spec.ts`, so it cannot drift (the spec prints the
expected text).

<!-- channels:start -->

| Channel | Rank | Pre-release form | Supports            | npm tag  | Image tags      | Trigger | Scheme  |
| ------- | ---- | ---------------- | ------------------- | -------- | --------------- | ------- | ------- |
| rc      | 3    | `-rc.N`          | major, minor, patch | `next`   | `rc`, `next`    | tag     | counter |
| stable  | 4    | none             | major, minor, patch | `latest` | `X.Y`, `latest` | tag     | counter |

<!-- channels:end -->

- **Release kind** comes from the base version: patch if Z > 0, minor if Z is 0 and Y > 0, major if
  it is X.0.0 (no special case for 0.x). A channel may release only the kinds it supports.
- **Guard.** A pre-release must be `<registered channel>.<N>`, N numeric without leading zeros.
  `v1.2.3-foo.1`, a bare `v1.2.3-rc`, `v1.2.3-rc-1` and `v1.2.3-rc.01` are refused, and so is a kind
  the channel does not support. The guard job repeats the rules in shell (it cannot import the
  registry); the spec runs it against the registry.
- **Re-running a pre-release after its stable shipped is refused**, by design: the stable tag
  exists, so the no-regression rule fires (fix forward with a new version).
- **No regression.** For one X.Y.Z a lower-ranked channel cannot follow an existing higher-ranked
  one (with `v1.2.0-rc.1` existing, a `beta` of 1.2.0 is refused), and no pre-release is released
  once the stable X.Y.Z exists. `verify` checks this against the `v` tags of its full checkout.
- **npm.** Each channel publishes under its own tag, forward-only: when the channel's tag already
  points at a greater version the version is published with `retry` instead, and a missing tag is
  eligible. `next` is the rc channel's tag. There is no `next` alias across channels on npm:
  trusted publishing covers `npm publish` only, and moving a tag later would need `npm dist-tag
  add`, which is not available to the workflow.
- **Images.** The exact tag always, then the channel's image tags, each forward-only by the
  `org.opencontainers.image.version` label: stable moves `X.Y` and `latest`, rc moves `rc` and
  `next` (the `next` alias is shared by the pre-release channels, so an older channel never moves
  it past a newer one). The partial-release check stays for stable releases only.

**Adding a channel is one more row**, its case arm in the guard step, and its pre-release name in
`release-pr-sync.yaml`'s branch parser (the specs check all three).
For example, if `alpha` and `beta` are wanted, for major and minor releases only:

```ts
{ name: "alpha", rank: 1, preRelease: "-alpha.N", supports: ["major", "minor"],
  npmTag: "alpha", imageTags: ["alpha", "next"], trigger: "tag", versionScheme: "counter" },
{ name: "beta", rank: 2, preRelease: "-beta.N", supports: ["major", "minor"],
  npmTag: "beta", imageTags: ["beta", "next"], trigger: "tag", versionScheme: "counter" },
```

The registry is validated by the spec: lowercase letter names that are not ranges and not
`latest`, `retry`, `next` or `bootstrap`; unique names, ranks and npm tags; ranks that follow the
SemVer order of the names (alpha < beta < rc) with stable last; a non-empty `supports` subset (stable
supports all three); and only stable may use `latest` and `X.Y`.

### Future: nightly (not implemented)

The `trigger` (`schedule`) and `versionScheme` (`snapshot`) fields are reserved for a nightly
channel, and the registry validation refuses them today. It needs its own amendment of the
[record](decisions/release-publishing.md) first: a separate `nightly` environment without
reviewers; a retention cap with **no prune**, deleting only named tags; whether npm trusted
publishing allows a second workflow file per package (an open point); no git tags, so `checkTags`
and the abandon flow do not apply; and a version such as `X.Y.Z-nightly.<date>.<sha>`, which does
not fit `<channel>.<N>`.

## The release workflow

`.github/workflows/release.yaml` runs these jobs in order, each needing the previous ones and
`guard`; the decision record has the permissions of each.

1. `guard`: the tag is a SemVer `v<version>` without build metadata, of a registered channel (see
   above), at most 128 characters
   after the `v`. It runs before any checkout.
2. `verify`: the tag equals the version of the root and every published manifest, the commit is on
   `main`, its `CI Passed` check succeeded, the previous stable release is complete (refuses a new
   stable release on a partial one unless that release is in `tooling/abandoned-releases.json`), then the full gate, the dry run and `test:packages` on Node
   22.12 and the current Node. It restores no cache: `verify` and `build` use the repository's
   `setup-workspace` action with `cache: "false"`, which installs Omni from its pinned release.
3. `build`: packs the tarballs once and uploads them with `SHA256SUMS`; the checksum of
   `SHA256SUMS` is a job output that later jobs check before using the tarballs.
4. `stage` (approval): builds each image once, pushes it as `sha-<commit>` (an existing tag is
   reused, never rebuilt) and creates the signed GitHub attestation for its digest.
5. `smoke`: installs and runs the exact tarballs on Node 22.12; pulls the exact staged digests and
   checks their labels.
6. `npm-publish` (approval): `npm publish` with trusted publishing (OIDC, no token) on Node 24.
   The dist-tag is explicit: the channel's tag (`latest` for stable, `next` for rc) when it is
   missing or the version is not lower than what it holds, else `retry`. A version already
   published is skipped only when its integrity and provenance match.
7. `image-publish` (approval): retags the staged digest as `X.Y.Z` (immutable), then `X.Y` and
   `latest` only for a stable version that is higher than what they hold, or the channel's own tags
   (`rc`, `next`) for a pre-release, each forward-only.
8. `post-verify`: `gh attestation verify` for each image digest and `npm audit signatures`.

Publishing cannot be undone, and a pushed tag stays. If a stable release stops part-way, the next
stable release is refused by `verify` (the partial-release check) until the failed one is dealt
with. There are two ways, in this order:

1. **Complete it (primary).** Re-run the failed jobs, or the whole run, of the same tag within the
   30-day artifact window (below). The run skips what is already published, finishes the rest, and
   the partial check then passes for the next release.
2. **Abandon it (after the window, or if it cannot be completed).** Add the exact version and a
   short reason to `tooling/abandoned-releases.json` in a reviewed commit, for example
   `[{ "version": "0.1.0", "reason": "npm stopped after sdk; the artifacts expired" }]`. The check
   then skips that version and walks down to the next stable tag that is not abandoned. The file
   is validated every time the check runs: stable SemVer only, a reason, no duplicates, and a
   `v<version>` tag must exist. The only version refused for its value is the one being released
   (it cannot be abandoned and released at once). A higher abandoned version is valid and simply
   ignored, so a backport such as 1.1.5 still releases while 1.2.0 is abandoned. **Do not remove
   an entry to unblock a backport**: the entry is correct, and removing it would make the check
   stop on the incomplete release again. Its tag stays. **Do these by hand first, before the
   abandonment commit** (they need the maintainer's npm credentials, not trusted publishing; that
   `npm dist-tag` works for the maintainer here is unverified):
    - For each package whose npm `latest` still points at the abandoned version, restore it with
      `npm dist-tag add <package>@<previous stable> latest`, where `<previous stable>` is the
      version the walk-down selects (the highest stable tag below the abandoned one that is not
      abandoned). If the package has no earlier stable version, run `npm dist-tag rm <package>
      latest` so `latest` is missing; the next stable release then takes it (the missing-`latest`
      case). The `0.0.0-bootstrap.0` placeholder lives under the `bootstrap` tag, not `latest`.
    - `npm deprecate` the packages of the abandoned version that were published.
    - Move the image `X.Y` and `latest` tags back by hand if they point at an unusable image. If no earlier image exists for a tag, remove that tag so it is missing.

    Then release a new version. This is a lead-decided policy to confirm; see the record.
    What the workflow could not verify is listed under "Written as fact but unverified" in the record;
    the `v0.1.0-rc.1` release settles it.

Limits of the first version:

- The partial-release check skips versions listed in `tooling/abandoned-releases.json` (an empty
  array today) and confirms the previous release's packages exist with provenance (it has
  no copy of that release's tarballs to compare integrity with), and it reads the images
  anonymously, so it needs their packages to be public. It requires `X.Y` only when the previous
  release is the highest patch of its minor and `latest` only when it is the highest stable version.
- A re-run of an older pre-release no longer moves the npm `next` tag backwards: it is published
  with `retry`, like an older stable version. There is still no cross-channel alias on npm.
- Push release tags **one at a time**: the workflow's concurrency group holds one running and one
  pending run, and GitHub may not start a run for every tag of a multi-tag push.
- The jobs that hold the OIDC token or write to the registry (`stage`, `npm-publish`,
  `image-publish`) install no dependencies. They run only `tooling/release-publish.ts`, which
  imports `node:` built-ins and the dependency-free `release-core.ts` and `semver-compare.ts`.
  `image-publish` verifies the staged attestations before it retags, and `post-verify` verifies
  them again, pinned to the `release.yaml` signer workflow and the tag ref.
- **Retry window: 30 days.** The tarball and staged-digest artifacts are kept for 30 days
  (`retention-days: 30`; the repository's own limit is 90), so a re-run of `npm-publish` or
  `image-publish` up to then still finds them. After that, completing the release is not possible
  and it is abandoned (see above) and fixed forward with a new version.
- **Backports.** A stable version lower than the package's current npm `latest` (for example 1.1.5
  after 1.2.0) is published with the `retry` dist-tag, not `latest`. It is on the registry, but
  `npm install <name>` does not get it; users pick it by version or by the `retry` tag.
- **A re-run of `stage` after a half-finished first run.** An existing `sha-<commit>` image is
  reused only if its attestation verifies (signer workflow, tag ref). If a first run pushed the
  image and failed before attesting, the re-run fails; delete that staging tag in GHCR by hand
  and re-run. The staged image is never rebuilt over an existing tag.
- **Credentialed jobs.** `stage`, `npm-publish` and `image-publish` run `bun --no-install
  tooling/release-publish.ts` (Bun's runtime would otherwise auto-install a missing bare import)
  and install nothing on the runner; `tooling/release.spec.ts` holds an allowlist of the commands
  and actions they may use. Accepted residual risks, not removed: the `bun install` inside the
  Dockerfiles, which runs in BuildKit during `stage`, and the `bun install` in `build` (which
  holds no credential but builds the tarballs that are published).
- A pending run: GitHub keeps one running and one pending run per concurrency group, so a third
  tag pushed while two runs exist cancels the pending one (this is why tags go one at a time).
- Lint the workflow with actionlint v1.7.12 (clean); v1.7.7 reports a false positive on the
  `artifact-metadata` permission.
