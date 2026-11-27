# Releases are published by one gated workflow

Date: 2026-11-27 (revised after independent review).
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
S8 <https://github.blog/changelog/2026-09-03-multiple-trusted-publishing-configurations-for-npm/>.
Anything not covered by these is marked **unverified**.

## Context

The repository is `launchpad-kit/launchpad` (transferred 2026-11-27) and the npm scope
`@launchpad-kit` belongs to the maintainer. Five packages are published in lockstep (`contracts`,
`sdk`, `client-core`, `cli`, `mcp`; the `core` group in `cog.toml`) and five images
(`controller`, `worker`, `router`, `admin`, `dokku`, built as `launchpad/*`, pushed to
`ghcr.io/launchpad-kit/launchpad-*`). Until now nothing publishes from CI, and
`tooling/ci.spec.ts` rejects any publish, push, tag or login command in every workflow. A local
publish cannot carry npm provenance and depends on a long-lived token on a personal machine.

## Decision

Exactly one workflow, `.github/workflows/release.yaml`, may publish. It must satisfy all of the
following.

### Trigger and tag guard

- `on.push.tags` takes **glob** patterns, not regular expressions [S2]. The trigger is
  `tags: ['v[0-9]+.[0-9]+.[0-9]+*']`. In the GitHub glob syntax `[0-9]` is a range, `+` means one or
  more of the preceding character, `*` matches zero or more characters except `/`, and `.` is
  literal [S2 cheat sheet]. The glob is deliberately loose: it also matches `v1.2.3garbage`.
- Package tags (`core-v0.1.0`, `@launchpad-kit/sdk-v0.1.0`) do not match, because the pattern is
  anchored at the start with `v`.
- The first job is a **mandatory guard** that validates `github.ref_name` against
  `^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$` (accepts `v0.1.0` and `v0.1.0-rc.1`) and fails
  otherwise. Every later job declares `needs:` on it. The dedicated spec asserts both the glob and
  the guard and the `needs:` edges.
- Never `pull_request`, `pull_request_target`, `schedule`, `workflow_dispatch` or `workflow_call`.
  (npm validates the calling workflow's name when `workflow_call` or `workflow_dispatch` is used
  [S1], another reason to exclude them.)
- The workflow resolves `GITHUB_SHA` once and every job uses only that commit.

### Cocogitto and the tag

`cog.toml` has `generate_mono_repository_global_tag = false` and creates package tags such as
`core-v0.1.0`. The release slice sets it to `true` so a global `v<semver>` tag exists [S6: `cog bump
--auto` creates package tags and a global mono-repository tag]. Cocogitto calculates the global
version from the package versions and from commits outside any package, and `public_api = false`
on a package keeps `--auto` from raising the global version [S6]. So the global version can differ
from the `core` lockstep version when tooling packages change. Which packages get `public_api =
false`, or whether the tag is created by hand, is decided in the `cog.toml` follow-up; whether
today's tooling packages would cause a mismatch is **unverified** (not inspected here).
`check:versions` fails a tag that differs from the manifests, so a mismatch fails safe.

### Approval and tag integrity

- The publish jobs run in the GitHub Environment `release` with **required reviewers** and
  **Prevent self-review**, and the environment's **Deployment branches and tags** is restricted to
  the tag pattern `v*` (and "Allow administrators to bypass" is turned off) [S3].
- A **tag ruleset** (not legacy tag protection) on `refs/tags/v*` restricts updates, deletions and
  non-fast-forward (block force pushes) [S4]; bypass actors are empty or admins only. It is a
  **precondition**: it exists before the workflow lands.
- A branch protection or ruleset on `main` (pull request required, `CI Passed` required) is a
  dependency: the "tagged commit is on `main`" check is only as strong as `main`.

### Verify before publishing

The workflow first checks that:

- the tag equals the lockstep version in every manifest (`check:versions`);
- the tagged commit is on `main`: `git merge-base --is-ancestor "$GITHUB_SHA" origin/main` after a
  `fetch-depth: 0` checkout and fetch;
- the commit's `CI Passed` check succeeded: `gh api repos/{owner}/{repo}/commits/$GITHUB_SHA/check-runs`
  is queried for a check named `CI Passed` with conclusion `success`; a missing check fails. That
  job needs `checks: read` [S2 permissions table];
- the full local gate and `test:packages` (Node 22.12 and current smoke) pass;
- the release dry run produces its artifacts and `SHA256SUMS`;
- the image smoke passes.

### Permissions and credentials

- Workflow default `contents: read`; permissions are set per job.
- `id-token: write` only on the npm publish job and on attestation steps; `packages: write` only on
  the image push job; `attestations: write` only if `actions/attest-build-provenance` is used;
  `checks: read` only on the verification job.
- No secrets other than the automatic `GITHUB_TOKEN`. No long-lived npm or registry token lives in
  the repository or the organisation. The publish job restores **no cache** (no Omni or Bun
  cache): a restored cache is a poisoning path, and npm's own example sets caching off [S1].

### npm

- Trusted publishing (OIDC) needs npm CLI >= 11.5.1 and Node >= 22.14.0 [S1]. The repository floor
  is Node 22.12, which is lower, so the publish job uses Node 24 or installs `npm@^11.5.1`.
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
  that passed the gates, verifying them against their `SHA256SUMS` first (`npm publish
  ./name.tgz --tag ...`). Packing with `bun pm pack` is fine because Bun rewrites `workspace:` and
  `catalog:` specifiers [S7]. That provenance is attached when publishing a pre-built tarball is
  **unverified**; the rc.1 smoke release confirms it.
- **Dist-tags.** `--tag next` for pre-releases and `latest` for stable versions. That
  `npm publish --tag` sets the tag at publish time without a separate dist-tag step is
  **unverified** in the docs checked (they describe `npm dist-tag` commands, which under OIDC need
  npm >= 11.21.0 and the separate "Allow npm dist-tag" permission [S1]); the rc.1 smoke confirms
  it, and the fallback is enabling that permission.
- **Order and idempotence.** `contracts`, `sdk`, `client-core`, then `cli` and `mcp`. Before each
  publish run `npm view name@version version`; skip if it exists. Never overwrite a version.
- **Partial publish.** Publishing five packages is not atomic. If it stops part-way, some
  versions are public and some are not. Re-running completes the missing ones (idempotence above);
  if a published package is wrong, deprecate it and fix forward with a new version.

### Images

- Every image carries `org.opencontainers.image.source` (mandatory); it links the package to the
  repository [S5]. The first push creates a **private** package [S5]; the maintainer flips
  visibility. `org.opencontainers.image.licenses` and `description` are also set [S5].
- buildx with `provenance: mode=max` and `sbom: true`. Each image is smoked **before** any exact
  version tag is pushed.
- GHCR does not enforce tag immutability (**unverified** in the pages checked, stated as a design
  assumption), so the workflow does: skip any image whose `X.Y.Z` tag already exists.
- `X.Y.Z` is immutable. `X.Y` and `latest` move only after smoke passes and only for stable
  releases. A pre-release gets only its exact tag.

## What stays forbidden

Publish, push, login or tag commands in any other workflow. The Release dry run workflow stays
manual, read-only and secret-free. `tooling/ci.spec.ts` keeps enforcing this for every workflow
except the single named release workflow, which gets its own spec asserting: the tag glob and the
guard job with its `needs:` edges, the `release` environment, per-job permissions, no secrets beyond
`GITHUB_TOKEN`, no cache restore in the publish job, and **full-commit-SHA action pins with the
version in a comment** (stricter than the other workflows on purpose). This change does not touch
`ci.spec.ts`, which still matches reality until the workflow lands.

## Maintainer steps (not done by agents)

Preconditions, before any release workflow lands:

1. Create a tag ruleset for `refs/tags/v*`: restrict updates and deletions, block force pushes,
   bypass actors empty or admins only.
2. Protect `main` (pull request required, `CI Passed` required) if it is not already.
3. Create the `release` environment in `launchpad-kit/launchpad` settings: required reviewers,
   Prevent self-review, deployment tags restricted to `v*`, administrator bypass off.

Around the first publish:

4. Bootstrap npm: a trusted publisher can only be configured on an existing package, and the first
   publish of a scoped package needs `--access public` (`publishConfig.access`). Publish each
   package once by hand with a one-time token that is never committed, then revoke it.
5. Configure a trusted publisher for each of the five packages (organisation `launchpad-kit`,
   repository `launchpad`, workflow file `release.yaml`, environment `release`, allowed action:
   direct `npm publish`). A new configuration must complete its first publish within 2 days or it
   expires [S1], so create them just before the `v0.1.0-rc.1` smoke release.
6. Then set each package to "Require two-factor authentication and disallow tokens" [S1].
7. Make the GHCR packages public after their first push.

## Consequences

- A compromised workflow can publish. Mitigations: environment approval with reviewers and no
  self-review, tag restriction, tag ruleset, minimal per-job permissions, no stored tokens, no
  cache, pinned actions, provenance.
- The repository gains a global `v<semver>` tag beside package tags.
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
- Keeping the old rule: leaves releases unattested and unrepeatable. Rejected.

## Follow-ups

- [ ] `release.yaml` and its dedicated spec; exempt only that file in `tooling/ci.spec.ts`.
- [ ] `cog.toml`: `generate_mono_repository_global_tag = true`; decide `public_api = false` on the
      tooling packages or tagging by hand.
- [ ] `publishConfig.access` and `repository` fields on the five package manifests.
- [ ] OCI labels (`source`, `licenses`, `description`) and licence notices in the images.
- [ ] Compose image references to the GHCR names.
- [ ] Release notes.
- [ ] `v0.1.0-rc.1` smoke release; confirm tarball provenance, `--tag next` and image tags.
