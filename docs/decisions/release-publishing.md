# Releases are published by one gated workflow

Date: 2026-11-27 (revised after three independent reviews).
Status: accepted by the maintainer on 2026-11-27. Supersedes the rule "nothing is published or
deployed from this repository's CI", stated in `README.md`, `CONTRIBUTING.md` (Checks) and
`docs/releasing.md` (introduction). Those sentences now point here.

Sources checked on 2026-11-27 (cited as [S1]...): S1 <https://docs.npmjs.com/trusted-publishers>,
S2 <https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax> (tag
filters, filter pattern cheat sheet, permissions),
S3 <https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments>,
S4 <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets>,
S5 <https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry>,
S6 <https://docs.cocogitto.io/guide/monorepo.html>,
S7 <https://bun.com/docs/pm/cli/publish> and <https://github.com/oven-sh/bun/issues/22423>,
S8 <https://github.blog/changelog/2026-09-03-multiple-trusted-publishing-configurations-for-npm/>,
S9 <https://docs.docker.com/build/ci/github-actions/attestations/>,
S10 <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows>,
S11 `cog bump --help` (local Cocogitto).
Anything not covered by these is marked **unverified**.

## Context

The repository is `launchpad-kit/launchpad` (transferred 2026-11-27) and the npm scope
`@launchpad-kit` belongs to the maintainer. Five packages are published in lockstep (`contracts`,
`sdk`, `client-core`, `cli`, `mcp`; the `core` group in `cog.toml`) and five images
(`controller`, `worker`, `router`, `admin`, `dokku`, built as `launchpad/*`, pushed to
`ghcr.io/launchpad-kit/launchpad-*`). Until now nothing publishes from CI, and
`tooling/ci.spec.ts` rejects any publish, push, tag or login command or secret in
`release-dry-run.yaml` (the other workflows are checked only for Bun, Vitest, TypeScript and Oxc
commands). A local
publish cannot carry npm provenance and depends on a long-lived token on a personal machine.

## Decision

Exactly one workflow, `.github/workflows/release.yaml`, may publish. It must satisfy all of the
following. Where a choice was made for the single-maintainer situation, the alternative is listed.

### Trigger and tag guard

- `on.push.tags` takes **glob** patterns, not regular expressions [S2]. The trigger is
  `tags: ['v[0-9]+.[0-9]+.[0-9]+*']`. In the GitHub glob syntax `[0-9]` is a range, `+` means one or
  more of the preceding character, `*` matches zero or more characters except `/`, and `.` is
  literal [S2 cheat sheet]. The glob is deliberately loose: it also matches `v1.2.3garbage`.
- Package tags (`core-v0.1.0`, `@launchpad-kit/sdk-v0.1.0`) do not match, because the pattern is
  anchored at the start with `v`.
- The first job (`guard`) validates `github.ref_name` against the SemVer 2.0.0 grammar (the
  `SEMVER` pattern in `tooling/versions.ts`) prefixed by `v`, without build metadata:
  `^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*)|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.((0|[1-9][0-9]*)|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$`.
  It accepts `v0.1.0`, `v0.1.0-rc.1` and `v1.2.3-rc-1` and rejects `v1.2.3+build.5`, `v01.2.3` and
  `v1.2.3garbage`. Release tags carry no build metadata: npm ignores it in version precedence, so
  two tags differing only by `+build` would be the same release. The glob is a superset of the
  guard, and the guard decides. Every later job declares `needs:` on it. The dedicated spec asserts
  the glob, the guard and the `needs:` edges.
- **Length.** The guard also fails when the version (the tag without the `v`) is longer than 128
  characters. A version becomes an image tag, and an OCI tag matches
  `[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}`, at most 128 characters
  (<https://raw.githubusercontent.com/opencontainers/distribution-spec/main/spec.md>, "Pulling
  manifests"), so `v1.2.3-` plus 123 letters would pass the regex but fail at the image step after
  npm had already published. npm publishes first, so the check runs in `guard`, before anything is
  published. npm's own version length limit is **unverified** (the 128-character bound is
  stricter than the 256 that `node-semver` uses, also unverified here). The spec asserts the
  length check.
- Never `pull_request`, `pull_request_target`, `schedule`, `workflow_dispatch` or `workflow_call`.
  (npm validates the calling workflow's name when `workflow_call` or `workflow_dispatch` is used
  [S1], another reason to exclude them.)
- The workflow resolves `GITHUB_SHA` once and every job uses only that commit.
- **Script injection.** `github.ref_name` and every other untrusted context value are passed
  through `env:` and read as shell variables. `${{ }}` is never interpolated into a `run:` block.
  The guard job does this, and the spec asserts that no `${{ github.ref_name }}` (or any other
  `${{ github.* }}` string value) appears inside a `run:` block.
- Operational note: GitHub does not create push or create events when more than three tags are
  pushed at once [S10, stated for the `create` and `delete` events; for `push` **unverified**].
  Push release tags one at a time.

### Cocogitto, tags and the bump commit

`cog.toml` sets `generate_mono_repository_global_tag = true` and
`generate_mono_repository_package_tags = false`, so `cog bump` creates one local `v<semver>` tag.

- Verified in a throwaway clone: `cog bump --auto` after a tooling-only commit (`fix:` under
  `packages/tsconfig`) created `v0.1.1` and a changelog-only bump **without** running
  `sync core`, so the manifests stayed at `0.1.0` and the global tag diverged from the lockstep
  version. `cog bump --version X.Y.Z` alone behaves the same (changelog only, manifests
  untouched). `cog bump --package core --version X.Y.Z` syncs the manifests but creates
  `core-vX.Y.Z`, not `v`.
- Verified: `cog bump --version X.Y.Z --include-packages` runs the hooks including
  `sync core`, rewrites every manifest, `bun.lock` and the source version strings, and creates
  only `vX.Y.Z`. It also sets the independent tooling packages to `X.Y.Z`. **This is the only
  supported way to bump.** `cog bump --auto` is not used.
- Guard: `omni run check:versions` (`checkTags` in `tooling/versions.ts`) fails when a reachable
  `v<semver>` tag is newer than the manifests. An untagged bump commit passes, because the tag
  is made after the merge. The guard cannot catch a diverged bump before it is tagged; the
  release checklist covers that. It compares full SemVer 2.0.0 precedence (build metadata
  ignored). With no git binary or no repository (a source tarball) it is skipped; any other
  failure of the tag query fails the check with git's message; a checkout with no `v` tags passes.
- `cog bump` creates the tag locally on the bump commit on the release branch, which is not the
  commit that lands on `main` after a squash or rebase merge. Do not push that tag. The
  maintainer deletes it and creates `v<semver>` **by hand on the merge commit on `main`**, after
  that commit's `CI Passed` is green and pushes it, as approved.
- Verified: with `skip_ci = ""` and both switches as above, the bump commit has no marker and
  only `vX.Y.Z` exists.

### Bump commit and CI

Cocogitto's `skip_ci` setting is a string added to the commits that `bump` and `commit` create,
default `[skip ci]` (<https://docs.cocogitto.io/reference/config.html>); `cog.toml` sets it to
`""`, and `cog bump` has `--skip-ci` and `--skip-ci-override` options [S11]. GitHub skips push
and pull request workflows for such a commit, so the bump commit would never get `CI Passed`. The
process, in the follow-up slice:

1. The bump is made on a release branch and opened as a **release pull request**; the bump commit
   must not carry the skip marker. The setting is changed in `cog.toml`; that an empty `skip_ci`
   removes the marker is **unverified**, so the slice confirms it or strips the marker another
   way.
2. Required checks (`CI Passed`) run on the pull request, and it is **merged** into `main`. The
   merge commit must also not carry the marker (check the squash or merge message).
3. Only then does the maintainer create the `v<semver>` tag on the merge commit on `main` (see
   above). A tag is never created on a commit without a green `CI Passed`; the workflow's check
   enforces it.

`cog.toml` now sets `skip_ci = ""` (verified: the bump commit carries no marker) and
`tooling/cog-config.spec.ts` asserts it.

### Amendment: the release PR workflow (maintainer-decided; implemented in `release-pr.yaml`)

A second workflow may write, within a narrow limit: it may push a branch `release/<version>` and
open a pull request, and it **never tags and never publishes**. Why it is allowed: the bump is
mechanical and the manual steps invite mistakes (a wrong pre-release number, a diverged tag, a
`[skip ci]` marker); the maintainer still reviews and merges the PR and still creates the tag by
hand on the merge commit, so the approval and tag-integrity controls above are unchanged.

It starts only by `workflow_dispatch` from `main`, with a base `X.Y.Z` and a channel from a static
list equal to the registry; the version and the pre-release number are computed from the registry
and the existing tags. It has **three jobs, a classic privilege split**, so that no code that comes
from dependencies ever holds a token that can write:

- `prepare` (`contents: read` only, no token with write scope, no environment) runs everything that
  executes dependency or repository code: `bun install`, Cocogitto and its version-sync hook,
  `cog bump`, the changelog and the body. It produces DATA only, a `git bundle` of the single bump
  commit and the PR body. A compromised dependency here can change that data and what its job
  outputs say, and can write Actions cache entries scoped to `main` (accepted: `ci.yaml` already
  does the same), but it cannot push, open a PR or dispatch anything.
- `push` (`contents: write` only; `environment: release-pr`) runs no repository code and installs
  nothing: only commands written in the workflow file. It checks out `main` without keeping the
  token, and validates the data before the token is used: the version against the dispatch inputs
  and the registry's channels; a bundle with exactly one ref and exactly one new commit directly on
  the checked-out `main` commit; the fixed message `chore(version): v<version>`; every changed
  path on the allowlist of `tooling/release-pr.ts` (manifests, the lockfile, changelogs and the
  three source files that hold a version string; directory components are `[a-z0-9-]+`, so `..`
  and `.git` never pass), as an addition or modification of a plain file no larger than 2 MiB;
  the commit object exactly (tree, the one parent, author, committer, the message, nothing else);
  and a manifest, `bun.lock` or source file changing only on its version line, which must carry
  this version, with a new manifest refused (`bun.lock` is held to the manifest rule because the
  dispatched `ci.yaml` runs `bun install` on it before anyone reviews it). Blobs are read with
  `git cat-file` into files and compared with `diff`, whose failure stops the job. It then checks
  exactly (with `git ls-remote --exit-code`, exit 2 meaning absent) that `release/<version>` does
  not exist and pushes **only** `<validated commit>:refs/heads/release/<version>` with an explicit
  refspec; the data is never checked out. It can write a branch under
  `release/`; `main` and `refs/tags/v*` are ruleset-protected, so it cannot touch them.
- `open-pr` (`pull-requests: write` only; `environment: release-pr`) runs no repository code, has
  no checkout and installs nothing: `gh pr create` with the body as a file (`--body-file`, never
  interpolated) and a title built from the validated version. The "Allow GitHub Actions to create
  and approve pull requests" setting therefore only ever matters to a job that runs no untrusted
  code. CI is not dispatched by this workflow (below).
  The PR body (mentions, closing keywords) comes from `prepare` and is accepted, size-capped
  (the tooling cuts it at 60,000 characters and `open-pr` refuses more than 65,000 bytes).
  `push` and `open-pr` each declare `environment: release-pr`, so a required reviewer on it would
  approve twice; the recommendation is the `main`-only branch policy and no required reviewers
  (a maintainer decision).

`tooling/ci.spec.ts` carves out exactly the one push command and the two job-scoped write scopes; `tooling/release-pr.spec.ts` asserts the rest, runs the real validation step against
repositories built to be refused (changed workflow, extra line in a manifest, deletion, mode
change, two commits, a merge commit, another message, wrong ref, wrong channel...) and compares
the shell allowlist, version-line shapes and channel names with the repository's.

**Trust boundary.** GitHub runs the workflow file from the dispatched branch, so dispatching a
branch with an edited `release-pr.yaml` runs the edited file, with that file's permissions. The
guard `refs/heads/main` in the first step is not a boundary against that. What limits it is who may
push such a branch and dispatch it (the maintainer) and, recommended, the `release-pr`
environment: set its deployment branch policy to `main` only (a maintainer step; the environment
is created on first use with no protection). That policy protects only jobs that still reference
the environment: a maintainer who dispatches an edited file that drops `environment:` is outside
it, so trust in who may dispatch and in reviewed workflow changes is part of the boundary. While
the jobs still reference `release-pr`, that policy keeps `push` and `open-pr`, the only jobs that
hold write scopes, from running on another branch.

A pull request created with the workflow token starts its `pull_request` run in the
**approval-required** state (documented behaviour; [GitHub docs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)).
A user with write access approves it with "Approve workflows to run" in the merge box, and that
run's `CI Passed` is the merge gate. CI is therefore **not** dispatched: a `workflow_dispatch` run
would not be a required check the ruleset honours, and the extra `actions: write` scope it needed
bought nothing. `ci.yaml` is unchanged from the normal pull request path. A lower base than the
latest tag (1.5.0 when `v2.0.0-rc.1` exists) is **accepted on purpose**, for backports; the
registry's rules and the no-regression rule still apply and the reviewer sees the version in the
PR. A dead branch, or one whose PR was closed unmerged, is removed by deleting `release/<version>`
and dispatching again.

### Approval and tag integrity

- **Who may create tags.** GitHub runs the workflow file from the tagged commit, so the gates in
  this record (commit on `main`, green `CI Passed`) are only as trustworthy as who may create a
  tag: anyone who can push a tag could push one on a commit with an edited workflow. The tag
  ruleset on `refs/tags/v*` (a ruleset, not legacy tag protection) therefore enables **Restrict
  creations**, **Restrict updates**, **Restrict deletions** and **Block force pushes** [S4], with
  one bypass actor: the maintainer (the repository admin role), who is the only person who pushes
  release tags. That bypass actors may create tags under "Restrict creations" is stated in the
  ruleset docs [S4]; the exact role selector in the UI is **unverified**.
- **Every publish job declares `environment: release`**: the npm publish job and the image publish
  job (and the staging-tag push, which writes to GHCR). No edited workflow can push to GHCR or npm
  without the environment's approval. The environment restricts **Deployment branches and tags**
  to the tag pattern `v*` and turns off "Allow administrators to bypass" [S3]. This is the second
  control after tag creation.
- **Required reviewers and self-review.** The repository has one maintainer. Decision: the
  required reviewer is the maintainer and **Prevent self-review is OFF** for now. The approval is
  then a deliberate manual gate and a typo guard, not a second-person control; the risk is that a
  compromised maintainer account approves its own release. Compensating controls: tag creation
  restricted to the maintainer, the deployment-tag restriction, SHA-pinned actions and minimal
  permissions. Turn Prevent self-review ON when a second maintainer exists. Alternative: a second
  reviewer account (rejected for now: a shared or throwaway account is not a real second person).
- A branch protection or ruleset on `main` (pull request required, `CI Passed` required) is a
  dependency: "the tagged commit is on `main`" is only as strong as `main`.

### Verify before publishing (`verify` job)

- The tag equals the version: `github.ref_name` must equal `v` + the root `package.json` version
  and `v` + the version of every published manifest, else fail. `check:versions` alone is not
  enough: it compares the workspace versions with the root version, not with the tag
  (`tooling/versions.ts`). Both run, and the spec asserts the explicit comparison.
- The tagged commit is on `main`: `git merge-base --is-ancestor "$GITHUB_SHA" origin/main` after a
  `fetch-depth: 0` checkout and fetch.
- The commit's `CI Passed` check succeeded. Query
  `gh api --paginate "repos/{owner}/{repo}/commits/$GITHUB_SHA/check-runs?per_page=100"`, select
  the check named `CI Passed` **and** created by the GitHub Actions app (`github-actions`; the
  exact JSON field for the app is **unverified**, confirm when writing the job). If the check was
  re-run, the latest completed run for that SHA counts: a `success` conclusion on it passes; no
  such run fails. This job needs `checks: read` and also `contents: read` for checkout.
- The full local gate and `test:packages` (Node 22.12 and current smoke) pass, and the release dry
  run produces its artifacts and `SHA256SUMS`.

### Job graph

| Job             | `needs`         | `environment` | Permissions                                                                                               | Purpose                                                                                                                                      |
| --------------- | --------------- | ------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `guard`         | none            | none          | none                                                                                                      | validate the tag from `env:`                                                                                                                 |
| `verify`        | `guard`         | none          | `contents: read`, `checks: read`                                                                          | checks above; no cache                                                                                                                       |
| `build`         | `verify`        | none          | `contents: read`                                                                                          | build the tarballs once; upload them with `SHA256SUMS`; output the SHA-256 of `SHA256SUMS`                                                   |
| `stage`         | `build`         | `release`     | `contents: read`, `packages: write`, `id-token: write`, `attestations: write`, `artifact-metadata: write` | build each image once, push it by digest under the staging tag `sha-<GITHUB_SHA>`, then create the signed GitHub attestation for that digest |
| `smoke`         | `stage`         | none          | `contents: read`, `packages: read`                                                                        | pull the exact staged digest and smoke it; install and smoke the tarballs                                                                    |
| `npm-publish`   | `smoke`         | `release`     | `contents: read`, `id-token: write`                                                                       | publish the tarballs                                                                                                                         |
| `image-publish` | `npm-publish`   | `release`     | `contents: read`, `packages: write`                                                                       | retag the staged digest as `X.Y.Z`, `X.Y`, `latest` (no new attestation: it is bound to the digest)                                          |
| `post-verify`   | `image-publish` | none          | `contents: read`, `packages: read`                                                                        | verify the attestations and signatures of everything published                                                                               |

- The workflow-level default is `permissions: {}`; each job states every permission it needs,
  including `contents: read` wherever it checks out code (a job that grants `checks: read` must
  restate `contents: read`).
- Every job that produces or verifies publishable artifacts (`verify`, `build`, `smoke`,
  `npm-publish`) restores **no cache**. `verify` and `build` set up through the repository's own
  `setup-workspace` action with `cache: "false"`, which skips both cache steps and installs Omni
  from its pinned release asset with a SHA-256 check; the remaining jobs keep
  `package-manager-cache: false` on `actions/setup-node`. A restored cache is a poisoning path
  [S1]. Every remote action a workflow names directly is pinned by full commit SHA (below).
- Images are published after npm: `image-publish` needs `npm-publish`. If npm succeeded and the
  images failed, a re-run skips npm versions that already exist with matching integrity and
  provenance (below) and continues with the images. Re-running the whole workflow from the failed
  job is the supported recovery; no manual npm step is needed.
- Whether the reviewer approves the three `release` environment jobs (`stage`, `npm-publish`,
  `image-publish`) as separate pending deployments or together is **unverified**; assume
  separately and approve each. `stage` and `npm-publish` may be merged into one approval later if
  GitHub allows it.

### Artifact handoff

`build` runs once. It uploads the tarballs and `SHA256SUMS` as one artifact and exposes the
SHA-256 of `SHA256SUMS` as a **job output**. Each later job that publishes downloads the artifact
and re-verifies it against that job output (and every tarball against `SHA256SUMS`) before it
publishes. A tarball is never rebuilt after `build`.

### Permissions and credentials

- No secrets other than the automatic `GITHUB_TOKEN`. No long-lived npm or registry token lives in
  the repository or the organisation.
- `id-token: write` is granted only to `stage` and `npm-publish`; `attestations: write` and
  `artifact-metadata: write` only to `stage`; `packages: write` only to `stage` and
  `image-publish`. `post-verify` has `packages: read`, because GHCR creates the packages private on
  the first push and it must read them before the maintainer flips visibility [S5];
  `gh attestation verify` itself needs no write permission (**unverified**: confirm when writing
  the job).

### npm

- Trusted publishing (OIDC) needs npm CLI >= 11.5.1 and Node >= 22.14.0 [S1]. The repository floor
  is Node 22.12, which is lower, so `npm-publish` uses Node 24 (or at least 22.14) **and** npm at
  least 11.5.1 (Node 24 ships a new enough npm; the job checks `npm --version`). It never runs
  trusted publishing on Node 22.12 with an upgraded npm. The spec asserts both minimums.
- It needs GitHub-hosted runners, `id-token: write`, a `package.json` `repository.url` that
  exactly matches the GitHub repository, and a trusted publisher whose workflow file name
  (including `.yaml`) and optional environment name match exactly; all fields are case-sensitive
  [S1]. npm does not validate the configuration when it is saved [S1].
- **Allowed actions.** Trusted publishers created after 2026-09-03 allow `npm stage publish` by
  default and direct `npm publish` only if selected [S1, S8]. Each publisher must therefore
  explicitly allow direct `npm publish`. Staged publishing (a maintainer approves each staged
  package with 2FA) is stronger [S1, S8] but needs a second manual step per package and is not
  chosen for 0.1.0; the environment approval is the gate. Revisit later.
- **Provenance** is generated automatically under trusted publishing from a public repository for
  a public package [S1]; `--provenance` is harmless and kept for clarity.
- **Publish command.** `npm publish` is the only publish command. `bun publish` is not used: Bun's
  docs say it cannot generate provenance and errors on `--provenance` [S7], and an open report
  says it does not support npm OIDC authentication [S7]; treat it as unsupported.
- **Exact tarballs.** The workflow publishes the tarballs the pack pipeline already produced and
  that passed the gates, verified against their `SHA256SUMS` (`npm publish ./name.tgz --tag ...`).
  Packing with `bun pm pack` is fine because Bun rewrites `workspace:` and `catalog:` specifiers
  [S7]. That provenance is attached when publishing a pre-built tarball is **unverified**; the
  rc.1 smoke release confirms it.
- **Dist-tags.** A tag is always passed explicitly with `--tag`, because `npm publish` without
  `--tag` defaults to `latest` (<https://docs.npmjs.com/cli/v12/commands/npm-publish/>; not
  re-fetched here, so the default is **unverified**). `--tag next` for pre-releases. For a stable
  version, the tag is decided **per package** from the package's current `latest` and `next`
  (`npm dist-tag ls <name>`; never `npm view`, which resolves a version through `latest` first and
  prints nothing when it is missing), in three cases: (a) `latest` is **missing** (only
  pre-releases or the `0.0.0-bootstrap.0` placeholder were published, so the first stable `0.1.0`
  has nothing to resolve by default): the package is eligible for promotion and is published with
  `--tag latest`; (b) the version is **lower** than the current `latest`: published with
  `--tag retry` and the release is fixed forward; (c) the version is **higher or equal**:
  `--tag latest`. Pre-releases never take `latest`. The spec asserts the missing case. This stops a retry of an older
  partial release from moving `latest` backwards, so packages never disagree. That
  `npm publish --tag` sets the tag at publish time without a separate dist-tag step is
  **unverified** in the docs checked (they describe `npm dist-tag` commands, which under OIDC need
  npm >= 11.21.0 and the separate "Allow npm dist-tag" permission [S1]); the rc.1 smoke confirms
  it, and the fallback is enabling that permission.
- **Order.** `contracts`, `sdk`, `client-core`, then `cli` and `mcp`. Never overwrite a version.
- **Idempotent re-run.** For each package run `npm view name@version dist.integrity`. Skip the
  version only when that integrity equals the integrity of the local tarball **and** a provenance
  attestation is present (`npm view name@version dist.attestations`, or `npm audit signatures`);
  otherwise **fail**. A package that was published by hand without provenance must not be skipped
  silently. That these two commands expose the attestation exactly as needed is **unverified**;
  the rc.1 smoke confirms it.
- **No new stable release on a partial one.** The `verify` job refuses to start a new stable
  release while the previous stable release V is partial. "Complete" is checked on content, not on
  whether tags exist, because floating tags from an older release still exist when V stopped
  before moving them: every one of the five packages has V with matching integrity and
  provenance, **and** the image tags `V`, `X.Y` (if V is the highest patch of its `X.Y`) and
  `latest` (if V is the highest stable version) resolve to the **same digest** as `sha-<commit of
  V>` (the staged digest; the commit is the one the tag `vV` points to), not merely exist. The
  previous release is resolved first (re-run it). With no previous stable release (the first
  `0.1.0`), there is nothing to check. The spec asserts this rule. Alternative, not chosen:
  record completion per release as a final job step (a `release-complete` git note or GitHub
  release object read by `verify`); it adds state that must itself be kept correct.
- **Amendment: abandoning a release (lead-decided policy, to be confirmed by the maintainer).** A
  failed stable release keeps its pushed tag, so by the rule above it would be the "previous"
  release forever and block every newer one; "fix forward" would deadlock. Recovery is therefore:
  (1) complete the failed release by re-running its failed jobs or run from the same tag within the
  30-day artifact retention window; the check then passes. (2) After the window, or when it cannot
  be completed, the maintainer abandons it in a reviewed commit that adds `{ version, reason }` to
  `tooling/abandoned-releases.json`. The check skips abandoned versions and walks down to the
  next stable tag that is not abandoned. The file must be valid (stable SemVer, no duplicates, an
  existing `v<version>` tag, and not equal to the version being released: it cannot be abandoned and
  released at once) or `verify` fails. A higher abandoned version is valid and irrelevant to the
  walk-down, which looks only below the version being released, so a backport (1.1.5 after an
  abandoned 1.2.0) still releases; removing an entry is **not** the way to unblock it, because the
  entry is right and its removal would make the check stop on the incomplete release again. Before
  the abandonment commit the maintainer, by hand: restores npm `latest` for each package that still
  points at the abandoned version (`npm dist-tag add <pkg>@<previous stable> latest`, the version the
  walk-down selects; with no earlier stable version `npm dist-tag rm <pkg> latest`, so `latest` is
  missing and the next stable takes it; the `0.0.0-bootstrap.0` placeholder is under `bootstrap`),
  and runs `npm deprecate` on the published packages. These `npm dist-tag` commands need the
  maintainer's credentials rather than trusted publishing, which is unverified. Its tag is never
  deleted. An abandoned version still
  counts as a higher stable version when deciding whether the previous release must hold `X.Y` or
  `latest`, so the check stays lenient there.
- **Amendment: release channels (maintainer-decided; implemented in `tooling/release-channels.ts`).**
  The channels a release can use are rows of a registry, which is the source of truth for the guard,
  the npm tag, the image tags and the promotion order; `docs/releasing.md` carries a table checked
  against it. Rows today: `stable` (rank 4, no pre-release part, npm `latest`, image tags `X.Y` and
  `latest`) and `rc` (rank 3, `-rc.N`, npm `next`, image tags `rc` and `next`), both for major,
  minor and patch releases, triggered by a tag with counter versions. `alpha` and `beta` are not
  added; each would be one row (major and minor only; npm tag `alpha`/`beta`; image tags the channel
  name and `next`) plus one `case` arm in the guard step and the regenerated docs table (the specs
  fail until all three agree). Rules: (1) **Guard strictness.** The tag pattern and the 128-character rule
  stay; a pre-release must also be `<registered channel>.<N>` with N numeric without leading zeros,
  so `-foo.1`, a bare `-rc`, `-rc-1` (previously accepted) and `-rc.01` are refused, and a channel
  must support the release kind: patch if Z > 0, minor if Z is 0 and Y > 0, major for X.0.0, with no
  special case for 0.x. The guard job repeats the rules in shell and the spec keeps the two in step.
  (2) **No regression.** For one X.Y.Z a lower-ranked channel cannot follow an existing
  higher-ranked one, and no pre-release is released once the stable X.Y.Z exists; `verify` checks it
  against the `v` tags of its `fetch-depth: 0` checkout. (3) **npm.** Each channel publishes under
  its own tag, forward-only: when that tag already points at a greater version the version is
  published with `retry`; a missing tag is eligible (the three-case rule of `latest`, generalised).
  `next` stays the rc channel's tag, as before. There is **no cross-channel `next` alias on npm**:
  trusted publishing covers `npm publish` only, so moving a tag after publishing would need
  `npm dist-tag add`, which the workflow does not have. (4) **Images.** The exact tag always, then
  the channel's image tags, each forward-only by the version label as before; the `next` image
  alias is shared by pre-release channels and so never moves past a newer one. (5) The
  partial-release check and the abandon flow stay for stable releases only. (6) **Nightly is
  deferred.** The registry reserves `trigger: schedule` and `versionScheme: snapshot` and refuses
  them today. A nightly channel needs its own amendment: a separate `nightly` environment without
  reviewers, a retention cap with no prune (only named tags are deleted), whether npm trusted
  publishing allows a second workflow file per package (open), no git tags (so `checkTags` and the
  abandon flow do not apply), and a version such as `X.Y.Z-nightly.<date>.<sha>` that does not fit
  `<channel>.<N>`.
- **Partial publish.** Publishing five packages is not atomic. If it stops part-way, some
  versions are public and some are not. Re-running completes the missing ones; if a published
  package is wrong, deprecate it and fix forward with a new version.

### Images

- Every image carries `org.opencontainers.image.source` (mandatory); it links the package to the
  repository [S5]. The first push creates a **private** package [S5]; the maintainer flips
  visibility. `org.opencontainers.image.licenses` and `description` are also set [S5].
- **Build once, push once, retag.** The `stage` job builds each image once with buildx
  `provenance: mode=max` and `sbom: true`. These buildx settings attach BuildKit attestations to
  the image; they are **not** the signed GitHub artifact attestation that `gh attestation verify`
  checks. So `stage` also runs an explicit attestation step for each staged image digest:
  `actions/attest` (`actions/attest-build-provenance` v4 is a wrapper around it) with
  `subject-name` set to the fully qualified image name without a tag
  (`ghcr.io/launchpad-kit/launchpad-<name>`), `subject-digest` set to the staged digest, and
  `push-to-registry: true`, with `id-token: write`, `attestations: write` and
  `artifact-metadata: write` (the permissions its README lists; the image push itself needs
  `packages: write`) (<https://github.com/actions/attest>,
  <https://github.com/actions/attest-build-provenance>). The storage record needs an
  organisation-owned repository, which `launchpad-kit` is; whether the step still needs
  `artifact-metadata: write` with `create-storage-record: false` is **unverified**. `post-verify`
  verifies these attestations. Attestations cannot be added when loading the build
  into the runner's local image store (`load: true`, or the docker exporter) [S9], so the image
  is pushed to the registry, not loaded. `stage` pushes the attested image by digest under a
  single staging tag `sha-<GITHUB_SHA>`. If `sha-<GITHUB_SHA>` already exists (a re-run of `stage`
  or of the whole workflow), `stage` **skips the build and the push** and reuses the digest of
  that existing tag as the source of truth; it never rebuilds it, because a rebuild would produce
  a different attested index digest (the provenance includes build data). `smoke` pulls that
  exact digest and smokes it. `X.Y.Z`, `X.Y` and `latest` are **retag-only** operations on
  that digest (`docker buildx imagetools create` or equivalent); nothing is rebuilt. That
  retagging keeps the attestations is **unverified**; confirm with `gh attestation verify` in
  `post-verify` on the first release (the attestation is bound to the digest, which retagging
  does not change). A rebuilt or locally loaded image would have a different
  digest, so no claim is made that it matches.
- GHCR does not enforce tag immutability (**unverified** in the pages checked, stated as a design
  assumption), so the workflow does. If `X.Y.Z` already exists (an earlier run pushed it and
  failed before moving `X.Y` and `latest`), the retry compares what `X.Y.Z` points to with the
  digest of `sha-<GITHUB_SHA>`, which is stable across retries because the build is not repeated.
  If they are equal, skip only the `X.Y.Z` retag and continue to move the floating tags; if they
  differ, fail.
- `X.Y.Z` is immutable. `X.Y` moves only after smoke passes, only for stable releases and only
  when the version being released is greater than the version `X.Y` currently points to, so a
  retry of 1.2.3 after 1.2.4 moved `1.2` does not move it backwards. Every image is built with the
  label `org.opencontainers.image.version` set to its version; the job reads that label from the
  image currently tagged `X.Y` (for example with `docker buildx imagetools inspect`; the exact
  command and field are **unverified**) and compares the two as SemVer. If `X.Y` does not exist, it
  is created. `latest` moves only for a stable version greater than the current latest stable
  (never backwards), compared the same way. The partial-release rule (a new stable release is
  refused while the previous one is partial) is the second guard. A pre-release gets only its exact tag and never moves a floating tag.
- No-overwrite applies only to npm versions and immutable `X.Y.Z` image tags and the staging tag;
  floating tags move as described.

### Post-publish verification (`post-verify`)

`gh attestation verify` for each pushed image digest and `npm audit signatures` for the published
packages, run after publishing. A failure is reported loudly; the response is deprecate and fix
forward (see Consequences), because publishing cannot be undone.

### Pinned actions

Every remote action that a release workflow names directly is pinned by **full commit SHA** with
the version in a comment, stricter than the other workflows on purpose. The dedicated specs assert
it, and allow one local action, `./.github/actions/setup-workspace`.

The shared setup action is where the tool versions live: Omni's version and the digest of its
release zip, and (for the release PR workflow) Cocogitto's version and the digest of its tarball.
Its own third-party actions (`omni-oss/setup-omni`, `oven-sh/setup-bun`, `actions/setup-node`,
`actions/cache`) stay on major-version tags. That is a deliberate exception: they run only in
jobs with `contents: read`, updating four SHAs per action per workflow was the larger cost, and
the repository at the tagged commit is immutable. A maintainer who wants stricter pins can move
them back to SHAs inside that one file.

## What stays forbidden

Publish, push, login or tag commands in any other workflow, except the one carve-out of the release PR
workflow (a push of its `release/<version>` branch, in its `push` job; see the amendment above). The Release dry run workflow stays
manual, read-only and secret-free. When the release workflow lands, `tooling/ci.spec.ts` is
extended to enforce this for every workflow except the single named release workflow, which gets
its own spec asserting: the tag glob and the guard job with its `needs:` edges, the `release`
environment on every publishing job, `permissions: {}` at workflow level and the per-job
permissions in the job graph, no secrets beyond `GITHUB_TOKEN`, no cache restore, no
`${{ github.ref_name }}` inside `run:` blocks, the npm and Node minimums, and full-SHA action pins.
`tooling/ci.spec.ts` enforces this for the other workflows and `tooling/release.spec.ts` is the dedicated
spec (both landed with the workflow).

## Maintainer steps (not done by agents)

Preconditions, before any release workflow lands:

1. Create the tag ruleset for `refs/tags/v*`: restrict creations, updates and deletions, block
   force pushes, one bypass actor (the maintainer, repository admin role).
2. Protect `main` (pull request required, `CI Passed` required) if it is not already.
3. Create the `release` environment in `launchpad-kit/launchpad` settings: the maintainer as
   required reviewer, Prevent self-review off for now, deployment tags restricted to `v*`,
   administrator bypass off.

Around the first publish:

4. Bootstrap npm. A trusted publisher can only be configured on an existing package, and the first
   publish of a scoped package needs `--access public` (`publishConfig.access`). Publish each of
   the five packages **once by hand** at the placeholder version `0.0.0-bootstrap.0` under the
   `bootstrap` dist-tag with `--access public`, using a one-time token that exists only during the
   bootstrap, then revoke it. Never publish the real `0.1.0` or an rc by hand: CI publishes
   `0.1.0-rc.1` and `0.1.0` with provenance. Versions are permanent, so deprecate the placeholder
   afterwards.
5. Configure a trusted publisher for each of the five packages (organisation `launchpad-kit`,
   repository `launchpad`, workflow file `release.yaml`, environment `release`, allowed action:
   direct `npm publish`). Configurations cannot be edited; a typo means delete and recreate, and
   the 2-day first-publish window restarts [S1]. A new configuration must complete its first
   publish within 2 days or it expires [S1], so create them just before the `v0.1.0-rc.1` smoke
   release.
6. Then set each package to "Require two-factor authentication and disallow tokens" [S1].
7. Make the GHCR packages public after their first push.

## Written as fact but unverified

My own list, because the review's list was not available to me. Each item is marked in the text.

- GHCR tag immutability is not enforced (design assumption).
- Provenance is attached when `npm publish` takes a pre-built tarball.
- `npm publish --tag next` sets the dist-tag at publish time under OIDC.
- `npm view ... dist.attestations` or `npm audit signatures` show attestations as the idempotence
  check needs.
- `imagetools create` retagging keeps the attestations.
- The check-runs JSON field that identifies the GitHub Actions app.
- The three-tag limit applies to `push` events, not only `create` and `delete`.
- Whether setting both `generate_mono_repository_*_tag` switches to `false` creates no tag
  (the configuration chosen keeps the global tag on).
- Whether the reviewer approves multiple `release` jobs together.
- The exact ruleset UI selector for the maintainer bypass actor.
- GitHub runs the workflow file from the tagged commit (stated by the review; not re-fetched here).

## Implementation notes

Where `release.yaml` is more specific than, or differs from, the text above:

- Every job except `guard` also lists `guard` in `needs:`, because `needs.guard.outputs.version`
  is readable only from a direct need.
- `guard` has `permissions: {}`, so it cannot check out; its shell step repeats the pattern of
  `tooling/release-plan.ts` (`TAG_PATTERN`), and the spec runs the step in bash and asserts the
  two agree. Later jobs run the tooling `guard` again.
- `setup-workspace` restores caches by default, so `verify` and `build` call it with
  `cache: "false"`. In that mode it installs Omni from the pinned release zip and checks its
  SHA-256 (the digest GitHub shows for the asset, confirmed by downloading it), and it skips both
  `actions/cache` steps. The version and digest exist only in that action; a spec asserts the
  workflow keeps no copy. The release PR workflow uses the same action for Omni and Cocogitto.
- `stage` is a matrix of the five images (the `admin` image is the `admin` target of the
  controller Dockerfile). Digests reach `smoke`, `image-publish` and `post-verify` as `staged-*`
  artifacts.
- The logic of `npm publish`, the dist-tag and the retag is in `tooling/release-publish.ts`
  (dependency-free) and the rest in `tooling/release-plan.ts`, both called as `bun tooling/<script>.ts
  <command>`; `npm publish` is spawned in the former with an explicit `--tag`, `--provenance` and `--access public`.
- The partial-release check verifies that the previous stable release's packages exist with a
  provenance attestation; it cannot compare integrity with that release's tarballs (they are not
  kept), so "matching integrity" holds only for the release being published (`publish-npm`). It
  reads the images anonymously (`verify` has no `packages: read`), so it needs the packages to be
  public, which the maintainer sets after the first push; with no previous stable release it
  checks nothing.
- `verify` runs the dry run with `--skip-images` (the images are built, smoked and attested in
  `stage`); `build` repeats it to produce the artifact.
- `smoke` installs the exact tarballs with npm (overrides to the files) on Node 22.12 and runs
  `launchpad --version`; it checks the exact staged digests by their labels and does not start the
  containers. `post-verify` installs the published packages from the registry for
  `npm audit signatures`.
- Added to the unverified list: the exact `npm dist-tag ls` output for a package whose only tag is
  `next` (the parser refuses any line it cannot read, so a difference fails closed); `npm view <name>@<version> dist.integrity` fails with E404 or prints
  nothing for a missing version; the `docker buildx imagetools inspect --format '{{json .}}'`
  shape (`Manifest.digest`, `Image` as a config or a platform map) and its "not found" wording;
  `gh attestation verify oci://...` needing only `packages: read`; whether each `stage` matrix leg
  asks for its own `release` approval; `setup-omni` is not used and `actions/*` versions are the
  latest at writing (checkout v7.0.1, setup-node v7.1.0, upload-artifact v7.0.2,
  download-artifact v8.0.2, setup-bun v2.2.0, docker login v4.8.0, setup-buildx v4.4.1,
  build-push v7.4.0, attest v4.2.2; SHAs read from the GitHub API on 2026-11-28), and
  their inputs were read from each action's `action.yml` at that SHA, not run.
- Security review fixes: `stage`, `npm-publish`, `image-publish` and `post-verify` install no
  dependencies and run only `tooling/release-publish.ts` (node: built-ins; pure logic in
  `release-core.ts`, `semver-compare.ts`; `release.spec.ts` asserts the imports and the absence of
  install steps). A floating tag that exists with an unreadable version label stops the retag
  instead of reading as missing. `publish-npm` checks the tarball set against `SHA256SUMS` and each
  tarball's version against the tag. The partial-release check takes the other stable versions as
  input (`X.Y` only for the highest patch, `latest` only for the highest stable). The spec rejects
  `if:` (but the one benign step), `continue-on-error`, a checkout without `persist-credentials:
  false` and `ref: ${{ github.sha }}`, and a job-level `GH_TOKEN` (each mutation was tried and
  fails the spec). `GH_TOKEN` is set on the `gh` steps only. `image-publish` runs
  `gh attestation verify` before retagging and `post-verify` pins `--signer-workflow` and
  `--source-ref refs/tags/v<version>` (both flags exist in `gh` 2.106's help; not run);
  `post-verify` retries the install of the published packages up to six times.
- Second security review: `classifyInspect` treats only `manifest unknown`, `MANIFEST_UNKNOWN`,
  `NAME_UNKNOWN` and a line ending in `: not found` (after dropping words with a `/`) as absent;
  timeouts, DNS errors, a credential helper not found, and a number such as 404 inside a ref are
  errors. The credentialed jobs run `bun --no-install tooling/release-publish.ts` (checked with
  Bun 1.4.4: without the flag a bare import is auto-installed when there is no `node_modules`, with
  it the run fails with "Cannot find package"). `release.spec.ts` holds an allowlist of the exact
  `run:` commands and actions of `stage`, `npm-publish` and `image-publish`, scans imports with
  `Bun.Transpiler.scanImports` plus a quote-agnostic pattern, and asserts no workflow-level `env`
  except the Omni pair, `defaults.run.shell: bash`, and no `||` in `image-publish` and
  `post-verify`. `stage` verifies the attestation of a reused staged image and attests only a
  fresh build. `publish-npm` requires exactly the five packages (tested with fake tarballs).
  Accepted residual risks: the Dockerfiles' `bun install` runs in BuildKit during `stage`, and
  `build` runs `bun install` (no credential, but it builds what is published).
  The runner image (ubuntu 24.04) lists Docker-Buildx 0.39.1, so `docker buildx imagetools` works in
  `image-publish` and `post-verify` without `setup-buildx` (read from the runner-images README;
  that `ubuntu-latest` is that image is unverified). GitHub keeps one running and one pending run
  per concurrency group.
- Added to the unverified list (second review): `NAME_UNKNOWN` (or another wording) on the first
  push of a never-pushed repository; the `.Image` label shape of an index with attestation
  manifests; `npm view` E404 versus empty output; whether a backport tagged `retry` is acceptable
  to users.
- Abandoned releases (CodeRabbit finding on the fix-forward deadlock): implemented as the amendment
  above, **a lead-decided policy to be confirmed**. The list is read in `tooling/release-plan.ts`
  (`verify` only, which installs dependencies); `release-core.ts` holds the pure validation and
  `previousStable`, and the credentialed jobs and their allowlist are unchanged. Nothing deprecates
  an abandoned version's packages automatically.
- Release channels: the registry module imports nothing and the credentialed jobs now import
  exactly `release-publish.ts`, `release-core.ts`, `release-channels.ts` and `semver-compare.ts`
  (the spec states this list on purpose). `verify` runs `release-plan.ts no-regression`, using the
  tags of its full checkout. The shell guard repeats the channel names and the kinds each supports;
  `release.spec.ts` compares them with the registry and runs the guard against a table of tags and
  every kind. Mutating the registry (an unregistered channel, a rank, a reserved npm tag) or the
  guard fails the specs. Unverified: that `actions/checkout` with `fetch-depth: 0` fetches every
  tag (its documented behaviour, not run here); the first rc run settles the `next` tag
  forward-only behaviour, read with `npm dist-tag ls`.
- Review of the channel registry: `retag` takes its docker runner and is tested with a fake
  registry (an rc, a stable, forward-only moves, a re-run, a clash, an unreadable label), so the
  tags it creates are asserted exactly. The registry validation is tested one change at a time
  with the named problem. `verify` runs `no-regression --require-tag`, so a tag listing that
  lacks the tag being released (an empty or shallow fetch) fails closed. Re-running a pre-release
  after its stable shipped is refused, by design (the stable tag exists, so the no-regression
  rule fires). Added to the unverified list: `npm dist-tag ls <name>` for a package with no
  versions at all (E404; publish-npm would stop, which the bootstrap placeholder avoids); the
  guard's `[a-z]` under the runner's locale (harmless: the channel name must equal a `case` arm).
- Release PR workflow, findings from a throwaway clone with the real `cog.toml` (cog 7.0.0; the clone
  had no earlier tags, so this is not the real tag history): `cog bump --version 0.1.0-rc.1
  --include-packages` works (commit `chore(version): v0.1.0-rc.1`, tag `v0.1.0-rc.1`, every manifest,
  the source version strings and `bun.lock` at the pre-release version; the three independent tooling
  packages also get that version and a `CHANGELOG.md`). `versions.ts check` agrees with the tag
  present and deleted. With the rc tag on the rc bump commit, `cog bump --version 0.1.0
  --include-packages` also works and `check` agrees. The committed `CHANGELOG.md` shows each
  release twice (`core-v…` and `v…` sections) and the stable section repeats the whole history
  (cog's bump changelog starts at the last _stable_ tag, none here), so the PR body is generated
  separately: `cog changelog --template remote --remote github.com --owner … --repository …
  <range>` works with ranges `<prev>..v<new>` and `..v<new>` and needs no `cog.toml` remote
  setting; a range lists a section per tag inside it. Cocogitto (libgit2) reads `user.name` and
  `user.email` from git config files only (`GIT_AUTHOR_*` and `GIT_CONFIG_COUNT` were not
  honoured), so the workflow sets them in its ephemeral checkout. The CI dispatch was removed
  (see the amendment): the approval-required `pull_request` run is the merge gate.
  Unverified: that the approval-required run appears and that approving it satisfies the ruleset
  on the PR; that `workflow_dispatch` check runs are not honoured by rulesets (the reason the
  dispatch was removed); that the PR can be created with
  the setting on; the pre-release range and the remote changelog template on the real repository's
  history; `git push` with the `http.extraheader` form against GitHub; `jq` on the runner.
- Release PR workflow, security review: the workflow is now three jobs (`prepare` read-only,
  `push`, `open-pr`), so the earlier sentence that the token never reaches dependencies is true by
  construction rather than by step-level care. `shellcheck` 0.11.0 (SHA-256 verified, run on every
  `run:` block of the three workflows) reports nothing for `release-pr.yaml`; in `release.yaml` it
  reported SC2209 on an unquoted `kind=patch` (quoted now) and SC2164 on a bare `cd` in two steps
  (left: `bash -e` stops on a failing `cd`, and the specs forbid `||` there). The commit-message
  check runs in `prepare` before anything is pushed and `push` re-checks the exact message.
  Unverified, added: whether `open-pr` needs `contents: read` for `gh pr create` (only
  `pull-requests: write` is granted); `git bundle verify`, `git fetch` from a bundle and
  `ls-remote --exit-code` with the `http.extraheader` form on the runner (run here only against
  local repositories); that the `release-pr` environment is created automatically on first use.
- Third review of the release PR workflow: the validation no longer fails open (blobs are read with
  `git cat-file` into files and `diff`'s status is checked; the spec runs the real step with a
  `diff` that exits 2), `bun.lock` and the manifests carry only version lines that embed this
  version, a changelog or any file above 2 MiB is refused, directory components are
  `[a-z0-9-]+` (crafted trees with `..` and `.git` entries are refused in the spec), the commit
  object is checked exactly, and `push` pushes the validated commit by SHA instead of checking out
  the data. `open-pr` keeps only `pull-requests: write` (the CI dispatch and its `actions: write`
  were removed): `gh pr create` uses
  GraphQL and the REST page for creating a pull request names no `contents` permission, so this is
  expected to suffice and is **unverified**. Added to the unverified list: the `diff` and `git
  cat-file` behaviour on a real runner beyond the local fixtures; that `ls-remote --exit-code`
  returns 2 for no match against GitHub (it does against a local bare repository).
- CodeRabbit review of PR #124: artifacts are kept 30 days, which is now the stated retry window
  (the record had none; GitHub's repository limit is 90 days; the 30 days a run can be re-run for
  is unverified). `setup-buildx` runs with `cache-binary: false` (the other cache-like inputs at the
  pinned SHAs are `package-manager-cache`, `no-cache`, and the unset `cache-from`/`cache-to`).
  The output shape of `docker buildx imagetools inspect --format '{{json .}}'` is now read from
  buildx v0.39.1's `util/imagetools/printers.go`: lowercase `name`, `manifest`, `image`; the index
  is printed with its own `digest`; `image` is one OCI image for one platform (attestation
  manifests are index entries linked by annotation, not platforms) and a platform map for several.
  The earlier unverified item about that shape is therefore settled by source, not by a run; that
  the runner's buildx (0.39.1 per the runner-images README) behaves the same is unverified. Existence
  is decided by `--raw` (resolve and read the tag's manifest only); the full inspection that also
  fetches child manifests may not report absent: a child `: not found` stops the release.
  `ci.spec.ts` compares parsed permissions, parsed `uses` values and the effective push filter.
  The staged attestations are verified in `smoke`, before `npm-publish`; what can still fail after
  npm publishes, untested against real tool output: `imagetools create` retagging and
  `image-publish`'s own `gh attestation verify`, `post-verify`'s `gh attestation verify` and
  `npm audit signatures` (which may fail on a dependency without signatures). A failure there is
  fixed forward (deprecate, re-run from the failed job).
- Known limit, not fixed: a re-run of an older release can move the `next` dist-tag backwards.
- Added to the unverified list: `gh attestation verify` in `image-publish` with only
  `contents: read` and `packages: write`; the `--signer-workflow` and `--source-ref` semantics for
  an attestation made by `actions/attest` (tag-triggered); the 20-second, six-attempt retry being
  enough for npm propagation.
- actionlint v1.7.12 reports nothing on the workflows (downloaded to `/tmp/opencode`); v1.7.7
  falsely rejects the `artifact-metadata` permission.
- Not run: the workflow itself, Docker builds and the registry
  commands. Only the unit specs and the guard step (in bash) were run.

## Consequences

- A compromised workflow can publish. Mitigations: tag creation restricted to the maintainer, the
  environment approval and deployment-tag restriction, tag ruleset, minimal per-job permissions,
  no stored tokens, no cache, pinned actions, provenance. With one maintainer, approval is not a
  second-person control (see Approval).
- The repository gains a global `v<semver>` tag (the only tag; package tags are off), created by `cog bump --version X.Y.Z --include-packages` locally and pushed by hand from `main`.
- Rollback: npm versions cannot be freely unpublished; deprecate the bad version
  (`npm deprecate`) and fix forward with a new version. `X.Y.Z` image tags are never rewritten;
  move `X.Y` and `latest` back to the last good image.

## Alternatives considered

- Manual local publish by the maintainer: cannot produce CI provenance and needs a long-lived
  token on a personal machine. Rejected.
- Third-party release actions: add supply-chain surface for steps that are a few commands.
  Rejected.
- Publishing from a protected local machine: same token and provenance problems, and not
  reproducible. Rejected.
- npm staged publishing as the default: stronger, but adds a manual approval per package;
  deferred, not rejected.
- A second reviewer account to enable Prevent self-review now: rejected until a real second
  person exists.
- Keeping the old rule: leaves releases unattested and unrepeatable. Rejected.

## Follow-ups

- [x] Job graph and `release.yaml` with its dedicated spec (`tooling/release.spec.ts`; decisions in
      `tooling/release-plan.ts`). `tooling/ci.spec.ts` now checks every workflow except
      `release.yaml` (and the setup action) for publish, login, tag and registry-push commands,
      publishing actions and credentials. `README.md`, `CONTRIBUTING.md` and `docs/releasing.md`
      no longer say nothing is published from CI. `AGENTS.md` was re-checked: no such statement.
- [ ] Tag creation procedure (release PR, merge, hand-made `v<semver>` tag on `main`, local
      Cocogitto tags removed) and the tag ruleset change with the single bypass actor.
- [x] Artifact checksum handoff: upload, job-output SHA-256, re-verify in every publish job.
- [x] Post-publish verification job (`gh attestation verify`, `npm audit signatures`).
- [ ] Bootstrap procedure for the five packages (placeholder version, `bootstrap` tag, token
      revoked), then trusted publishers and disallow-tokens.
- [x] Bump CI: `skip_ci = ""`, so the bump commit has no `[skip ci]` and CI runs on it.
- [x] `cog.toml`: one global `v<semver>` tag, no package tags; bump only with
      `cog bump --version X.Y.Z --include-packages`; the tag is pushed by hand from `main`.
- [ ] Package metadata: `publishConfig.access` and, in the **packed** manifests, `repository`
      (type `git`, url `git+https://github.com/launchpad-kit/launchpad.git`, `directory` per
      package), `homepage` and `bugs`. `tooling/package-clients.ts` builds new manifests and does
      not copy `repository` from the source manifests, so the staging pipeline must emit these and
      `checkManifest`/`checkLibrary` must assert them (the exact `repository.url` trusted
      publishing needs).
- [x] OCI labels (`source`, `licenses`, `description`) and licence notices in the images.
- [x] Compose image references to the GHCR names (`LAUNCHPAD_IMAGE_TAG` required, no `latest` default).
- [ ] Release notes.
- [ ] `v0.1.0-rc.1` smoke release; confirm tarball provenance, `--tag next`, retag attestations and
      image tags.
