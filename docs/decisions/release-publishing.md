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

`cog.toml` has `generate_mono_repository_global_tag = false` and creates package tags such as
`core-v0.1.0`. The release slice decides the global version as below.

- A `v<semver>` global tag is wanted [S6]. Cocogitto calculates the global version from the package
  versions and from commits outside any package, and `public_api = false` on a package keeps
  `--auto` from raising it [S6]. So the global version can differ from the `core` lockstep
  version when tooling packages change. Whether today's tooling packages cause a mismatch is
  **unverified**. The explicit tag-to-manifest comparison (below) fails a mismatched tag, so a
  mismatch fails safe.
- **`cog bump` creates tags locally on the bump commit on the release branch**, and that commit is
  not the commit that ends up on `main` after a squash or rebase merge. So the release slice must
  not push any Cocogitto tag. `cog bump --help` lists a way to skip the bump commit
  (`--disable-bump-commit`) but no flag to skip tags [S11]; `cog.toml` has
  `generate_mono_repository_global_tag` and `generate_mono_repository_package_tags` switches [S6
  config reference], and whether setting both to `false` creates no tag at all is **unverified**.
  The release slice therefore either turns them off after verifying that, or deletes every local
  tag the bump created (`core-v*`, `v*`, tooling package tags) before anything is pushed.
- The maintainer then creates `v<semver>` **by hand on the merge commit on `main`**, after that
  commit's `CI Passed` is green. Because the tag is created on `main`, squash and rebase merges
  are fine.

### Bump commit and CI

Cocogitto's `skip_ci` setting is a string added to the commits that `bump` and `commit` create,
default `[skip ci]` (<https://docs.cocogitto.io/reference/config.html>); `cog.toml` uses the
default, and `cog bump` has `--skip-ci` and `--skip-ci-override` options [S11]. GitHub skips push
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

Until then `docs/releasing.md` still describes the `[skip ci]` flow and says it changes with the
follow-up.

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
  `npm-publish`) restores **no cache**: not the repository's `setup-workspace` action as it is
  today, no Omni or Bun cache restore, and `package-manager-cache: false` on `actions/setup-node`.
  A restored cache is a poisoning path [S1]. Every action is pinned by full commit SHA (below).
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
  version, the tag is decided **per package** from the package's current `latest`
  (`npm view <name> dist-tags.latest`), in three cases: (a) `latest` is **missing** (only
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

For `release.yaml`, every `uses:` is pinned by **full commit SHA** with the version in a comment,
stricter than the other workflows on purpose. The dedicated spec asserts it.

## What stays forbidden

Publish, push, login or tag commands in any other workflow. The Release dry run workflow stays
manual, read-only and secret-free. When the release workflow lands, `tooling/ci.spec.ts` is
extended to enforce this for every workflow except the single named release workflow, which gets
its own spec asserting: the tag glob and the guard job with its `needs:` edges, the `release`
environment on every publishing job, `permissions: {}` at workflow level and the per-job
permissions in the job graph, no secrets beyond `GITHUB_TOKEN`, no cache restore, no
`${{ github.ref_name }}` inside `run:` blocks, the npm and Node minimums, and full-SHA action pins.
This change does not touch `ci.spec.ts`, which still matches reality until the workflow lands.

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
- Setting both `generate_mono_repository_*_tag` switches to `false` creates no tag; an empty
  `skip_ci` removes the marker.
- Whether today's tooling packages make the global version differ from the lockstep version.
- Whether the reviewer approves multiple `release` jobs together.
- The exact ruleset UI selector for the maintainer bypass actor.
- GitHub runs the workflow file from the tagged commit (stated by the review; not re-fetched here).

## Consequences

- A compromised workflow can publish. Mitigations: tag creation restricted to the maintainer, the
  environment approval and deployment-tag restriction, tag ruleset, minimal per-job permissions,
  no stored tokens, no cache, pinned actions, provenance. With one maintainer, approval is not a
  second-person control (see Approval).
- The repository gains a global `v<semver>` tag beside package tags, created by hand on `main`.
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

- [ ] Job graph and `release.yaml` with its dedicated spec. Extend `tooling/ci.spec.ts` so every
      workflow except `release.yaml` is checked for publish, login, tag and registry-push commands
      and for secrets, matching commands in command position (not trigger keys such as
      `on: push`). In the same change update every statement that nothing is published from CI:
      `README.md`, `CONTRIBUTING.md`, `docs/releasing.md`. `AGENTS.md` was checked and has no such
      statement (it only forbids starting servers or deployments unless asked); re-check it then.
- [ ] Tag creation procedure (release PR, merge, hand-made `v<semver>` tag on `main`, local
      Cocogitto tags removed) and the tag ruleset change with the single bypass actor.
- [ ] Artifact checksum handoff: upload, job-output SHA-256, re-verify in every publish job.
- [ ] Post-publish verification job (`gh attestation verify`, `npm audit signatures`).
- [ ] Bootstrap procedure for the five packages (placeholder version, `bootstrap` tag, token
      revoked), then trusted publishers and disallow-tokens.
- [ ] Bump CI: the Cocogitto bump commit carries `[skip ci]` (`skip_ci` in `cog.toml`), so GitHub
      skips its workflows and it cannot supply `CI Passed`. See "Bump commit and CI". Change
      `skip_ci` and update `docs/releasing.md` in the same slice.
- [ ] `cog.toml`: decide the tag switches (Cocogitto tags are never pushed; the global `v<semver>` tag is made by hand on `main`) and `public_api = false` on the
      tooling packages or tagging by hand.
- [ ] Package metadata: `publishConfig.access` and, in the **packed** manifests, `repository`
      (type `git`, url `git+https://github.com/launchpad-kit/launchpad.git`, `directory` per
      package), `homepage` and `bugs`. `tooling/package-clients.ts` builds new manifests and does
      not copy `repository` from the source manifests, so the staging pipeline must emit these and
      `checkManifest`/`checkLibrary` must assert them (the exact `repository.url` trusted
      publishing needs).
- [ ] OCI labels (`source`, `licenses`, `description`) and licence notices in the images.
- [ ] Compose image references to the GHCR names.
- [ ] Release notes.
- [ ] `v0.1.0-rc.1` smoke release; confirm tarball provenance, `--tag next`, retag attestations and
      image tags.
