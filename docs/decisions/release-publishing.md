# Releases are published by one gated workflow

Date: 2026-11-27.
Status: accepted by the maintainer on 2026-11-27. Supersedes the rule "nothing is published or
deployed from this repository's CI", stated in `README.md`, `CONTRIBUTING.md` (Checks) and
`docs/releasing.md` (introduction). Those sentences now point here.

## Context

The repository is `launchpad-kit/launchpad` (transferred 2026-11-27) and the npm scope
`@launchpad-kit` belongs to the maintainer. Five packages are published in lockstep (`contracts`,
`sdk`, `client-core`, `cli`, `mcp`; the `core` group in `cog.toml`) and five images
(`controller`, `worker`, `router`, `admin`, `dokku`, built as `launchpad/*`, pushed to
`ghcr.io/launchpad-kit/launchpad-*`). Until now nothing publishes from CI, and
`tooling/ci.spec.ts` rejects any publish, push, tag or login command in every workflow. A local
publish cannot carry npm provenance, and depends on a long-lived token on a personal machine.

## Decision

Exactly one workflow, `.github/workflows/release.yaml`, may publish. It must satisfy all of:

**Trigger.** Only a pushed tag matching `^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$`
(`v0.1.0`, `v0.1.0-rc.1`). Never `pull_request`, `pull_request_target`, `schedule` or
`workflow_dispatch`. Cocogitto today has `generate_mono_repository_global_tag = false` and creates
package tags such as `core-v0.1.0`; the release slice sets it to `true` so a global `v<semver>`
tag exists, and the workflow ignores package tags.

**Approval.** Every publish job runs in the GitHub Environment `release`, which has required
reviewers, so a person approves before anything is published.

**Permissions.** Workflow default `contents: read`, set per job. `id-token: write` only on the npm
publish job (trusted publishing and provenance) and on attestation steps; `packages: write` only on
the image push job. No other secrets.

**No stored credentials.** No long-lived npm or registry token lives in the repository or the
organisation. npm uses trusted publishing (OIDC); GHCR uses the job's `GITHUB_TOKEN`. Bootstrap
caveat: a package must exist before a trusted publisher can be attached, so the first publish of
each package may need a one-time token set by the maintainer outside the repository, never
committed, and revoked afterwards.

**Provenance.** `npm publish --provenance`; images are built with buildx provenance and SBOM
attestations.

**Verify before publishing.** The workflow first checks that: the tag equals the lockstep version
in every manifest (`check:versions`); the tagged commit is on `main` with a green `CI Passed`; the
full local gate passes; `test:packages` passes (Node 22.12 and current smoke); the release dry run
produces its artifacts and `SHA256SUMS`; the image smoke passes.

**Order and idempotence.** npm first, in dependency order (`contracts`, `sdk`, `client-core`, then
`cli` and `mcp`), then images. A re-run skips versions and tags that already exist and never
overwrites one.

**Tags.** npm: `next` for pre-releases, `latest` only for stable versions. Images: `X.Y.Z` is
immutable; `X.Y` and `latest` move only after smoke passes and only for stable releases; a
pre-release gets only its exact tag.

## What stays forbidden

Publish, push, login or tag commands in any other workflow. The Release dry run workflow stays
manual, read-only and secret-free. `tooling/ci.spec.ts` keeps enforcing this for every workflow
except the single named release workflow, which gets its own spec asserting the above: triggers,
environment, per-job permissions, no secrets beyond those named, and the pinned-action policy.
This change does not touch `ci.spec.ts`, which still matches reality until the workflow lands.

## Maintainer steps (not done by agents)

1. Create the `release` environment in `launchpad-kit/launchpad` settings with required reviewers.
2. Configure an npm trusted publisher for each of the five packages (organisation `launchpad-kit`,
   repository `launchpad`, the workflow file name, environment `release`), after the one-time first
   publish where needed.
3. Make the GHCR packages public after their first push.
4. Add a tag ruleset protecting `v*` so only maintainers create or delete release tags.

## Consequences

- A compromised workflow can publish. Mitigations: environment approval, minimal per-job
  permissions, no stored tokens, tag ruleset, and provenance that lets consumers see what built
  each artifact.
- The repository gains a global `v<semver>` tag beside package tags.
- Rollback: npm versions cannot be freely unpublished; deprecate the bad version
  (`npm deprecate`) and fix forward with a new version. Images with `X.Y.Z` tags are never
  rewritten; move `X.Y` and `latest` back to the last good image.

## Alternatives considered

- Manual local publish by the maintainer: cannot produce CI provenance and needs a long-lived
  token on a personal machine. Rejected.
- Third-party release actions: add supply-chain surface for steps that are a few commands.
  Rejected.
- Publishing from a protected local machine: same token and provenance problems, and not
  reproducible. Rejected.
- Keeping the old rule: leaves releases unattested and unrepeatable. Rejected.

## Follow-ups

- [ ] `release.yaml` and its dedicated spec; exempt only that file in `tooling/ci.spec.ts`.
- [ ] `cog.toml`: `generate_mono_repository_global_tag = true`.
- [ ] OCI labels and licence notices in the images.
- [ ] Compose image references to the GHCR names.
- [ ] Release notes.
- [ ] `v0.1.0-rc.1` smoke release.
