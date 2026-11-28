# Plan: release 0.1.0 (npm packages and Docker images)

Status: refreshed 2026-11-27 against `main` at `4ea4908` (#120). It replaces an earlier draft written
against `cc2a846`, when the licence, scope, repository and publish policy were all still open.
Nothing was built, packed, published, tagged or pushed to write this. Every "merged" below comes
from the repository (commit titles, files, `grep`), not from running the gates or the image builds.

## Assessment

- Kind: **large**. It crosses packaging, CI, registries, docs and a policy change.
- Risk: **high**. npm versions and public image tags are effectively irreversible, and the
  repository says the Compose stack has never run as production
  ([production Compose](../production-compose.md)). 0.1.0 is an explicit early release.
- The groundwork is merged. What remains is the release workflow, hand-made registry setup and
  the first publishes.

## Merged

| PR   | What                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #113 | Published npm packages stay runtime agnostic (`check:runtime`); `test:packages` installs and runs the tarballs on Node and Bun                                           |
| #114 | The typed commander wrapper is used everywhere and guarded                                                                                                               |
| #115 | `cli` and `mcp` publish **unbundled**, with `client-core`: the public set is `contracts`, `sdk`, `client-core`, `cli`, `mcp` (`TARGETS` in `tooling/package-clients.ts`) |
| #116 | `client-core` gets a named public API, redaction of the run's secrets and a security model                                                                               |
| #117 | Licence: Apache-2.0 (root `LICENSE`, carried in every tarball)                                                                                                           |
| #118 | Decision record [release publishing](../decisions/release-publishing.md): one gated workflow may publish                                                                 |
| #119 | `repository`, `homepage` and `bugs` in every packed manifest (repository transferred to `launchpad-kit/launchpad`)                                                       |
| #120 | One global `v<semver>` tag; bump only with `cog bump --version X.Y.Z --include-packages`; `skip_ci = ""`; `checkTags` guard in `check:versions`                          |
| #121 | OCI labels, licence notices in the images, and `LAUNCHPAD_IMAGE_TAG` required in `docker-compose.yaml` (no default)                                                      |

Also in place: the lockstep version (`cog.toml` `core` group, `tooling/versions.ts`), the read-only
manual dry run (`.github/workflows/release-dry-run.yaml`), forward-only migrations and the
[upgrade](../upgrade.md) and [restore](../restore.md) procedures.

## What remains

Owners: **USER** does it by hand in a web UI or with a credential; **AGENT** is repository work.

| #   | Item                                                                                                                                                                                              | Owner                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | Protect `main` (pull request required, `CI Passed` required), if not already                                                                                                                      | USER                      |
| 2   | Tag ruleset on `refs/tags/v*` (restrict creations, updates, deletions; block force pushes; maintainer as the one bypass actor)                                                                    | USER                      |
| 3   | `release` environment: maintainer as reviewer, Prevent self-review off for now, deployment tags `v*`, administrator bypass off                                                                    | USER                      |
| 4   | npm org `launchpad-kit` ownership and 2FA (**unverified**: the scope has never been checked)                                                                                                      | USER                      |
| 5   | Bootstrap: publish each of the five packages once by hand as `0.0.0-bootstrap.0` under the `bootstrap` tag with `--access public`, using a one-time token, then revoke it                         | USER                      |
| 6   | Trusted publisher per package (org `launchpad-kit`, repo `launchpad`, workflow `release.yaml`, environment `release`, direct `npm publish` allowed); then "require 2FA and disallow tokens"       | USER                      |
| 7   | GHCR packages public after their first push                                                                                                                                                       | USER                      |
| 8   | `.github/workflows/release.yaml` and its dedicated spec, as the decision record specifies                                                                                                         | AGENT                     |
| 9   | Extend `tooling/ci.spec.ts` so every workflow except `release.yaml` is checked for publish, push, tag and login commands and secrets (today only `release-dry-run.yaml` is)                       | AGENT                     |
| 10  | In the same change, update the "nothing is published from CI" sentences (`README.md`, `CONTRIBUTING.md`, `docs/releasing.md`)                                                                     | AGENT                     |
| 11  | Real Docker verification of `test:images` and the dry-run image build (not run for #121 or this plan)                                                                                             | AGENT                     |
| 12  | `v0.1.0-rc.1` smoke release; `v0.1.0` final                                                                                                                                                       | AGENT with USER approvals |
| 13  | Deferred `client-core` audit findings 5-14 and 20 (non-blocking; the list is in `docs/releasing.md` only as "remaining audit findings", the findings themselves are **not in the repository**)    | AGENT                     |
| 14  | Rehearsal follow-ups, recorded not fixed ([source](production-compose-follow-up.md)): an unreproduced held promotion; a backup killed mid-write; an unclassified `ERR_POSTGRES_CONNECTION_CLOSED` | AGENT                     |
| 15  | Review the draft [release notes](../release-notes/0.1.0.md) and replace the changelog baseline question (below)                                                                                   | USER                      |

## Ordered checklist

1. [ ] USER: **approve the open decisions** (tag policy, rc.1 first, amd64 only, Compose tag, changelog baseline). Until then everything below that depends on them (the rc.1 steps, the tag and image tag rules) is proposed, not decided. Do this before the workflow is implemented or anything is published.
2. [ ] USER: items 1-4 above (`main` protection, tag ruleset, `release` environment, npm scope).
3. [ ] AGENT: `release.yaml`, its spec, and the `ci.spec.ts` extension (items 8-10), following the approved decisions: written (PR #124), to be reviewed and merged, not yet run.
4. [ ] AGENT: Docker verification of the image builds (item 11).
5. [ ] USER: bootstrap publish of `0.0.0-bootstrap.0`, revoke the token (item 5).
6. [ ] **Only if rc.1 first is approved:** create the trusted publishers just before the rc, since an unused configuration expires after 2 days (item 6; decision record); `cog bump --version 0.1.0-rc.1 --include-packages` on a clean checkout; release PR; merge; hand-made `v0.1.0-rc.1` tag on the merge commit; approve the `release` jobs; confirm what the decision record lists as unverified (below) from the rc run and fix the workflow if any is wrong. If rc.1 is rejected, those statements are first confirmed by the final release, which is a higher risk, and the plan must be revised: the first GHCR push and everything in step 7 then move to the final release (step 8) and follow it. The trusted publishers must exist before step 8 publishes.
7. [ ] **Only if rc.1 ran:** USER: GHCR packages public (item 7); clean-machine smoke test from published artifacts only. Without an rc, do this after step 8, once the first images exist.
8. [ ] Final release PR: `cog bump --version 0.1.0 --include-packages` **and** the final `docs/release-notes/0.1.0.md` (DRAFT banner removed, content final) and current `docs/releasing.md`, so the tagged revision carries the final notes. Merge, then create tag `v0.1.0` on the merge commit, approve the jobs, and verify. (In every path the trusted publishers exist before this step publishes; create them just before it if rc.1 was skipped, since an unused configuration expires after 2 days.)

## Still unverified (from the decision record)

Marked **unverified** in [release publishing](../decisions/release-publishing.md); the rc.1 run is
meant to settle the first five.

- Provenance is attached when `npm publish` takes a pre-built tarball.
- `npm publish --tag` sets the dist-tag at publish time under OIDC (fallback: the "Allow npm dist-tag" permission).
- `npm view ... dist.attestations` or `npm audit signatures` expose the attestation as the idempotent re-run needs.
- `imagetools create` retagging keeps the attestations.
- GHCR does not enforce tag immutability (design assumption).
- The check-runs JSON field that identifies the GitHub Actions app.
- The three-tag limit also applies to `push` events.
- Whether the reviewer approves the three `release` jobs together or separately.
- The ruleset UI selector for the maintainer bypass actor.
- That GitHub runs the workflow file from the tagged commit.
- The `npm publish` default dist-tag, npm's version length limit, and whether `artifact-metadata: write` is needed with `create-storage-record: false`.
- Added by the workflow (see the record's implementation notes): the `npm view` outputs for a missing `latest` or version, the `imagetools inspect` JSON shape, `gh attestation verify` permissions, whether each matrix leg needs its own `release` approval, and that the workflow was never run.
- Not in the record: the packed tarballs and the image builds were not run for this plan.

## Open decisions (proposed, not decided)

The user has **not** answered these. Each default below is a proposal and is not decided; nothing
should be built on it as if it were.

| Decision                       | Proposed default (not decided)                                                                                                                                        | Rationale                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Tag policy                     | `X.Y.Z` immutable; `X.Y` and `latest` float, moved only after the smoke test and only for stable releases; git tag `v<semver>`                                        | The decision record already designs for this; it avoids moving users silently                                               |
| `0.1.0-rc.1` pre-release first | Yes: `rc.1` under npm tag `next`, image tag without `latest`, then `0.1.0`                                                                                            | It is the only way to settle the unverified statements above before irreversible versions are public                        |
| Architectures                  | `linux/amd64` only, stated in the notes                                                                                                                               | `docs/install.md` is written for Linux/amd64 and no arm64 build has been tested                                             |
| Required Compose tag           | **Implemented in #121**: `LAUNCHPAD_IMAGE_TAG` is required. Proposed: keep it                                                                                         | It removes an unpinned `latest`; the decision about it was recorded as proposed, not confirmed                              |
| Changelog baseline             | Create no baseline tag; ship curated `docs/release-notes/0.1.0.md`, and accept that the first generated `CHANGELOG.md` covers all history (`from_latest_tag = false`) | A baseline tag would be an extra `v` tag that `checkTags` would treat as a release; the generated log is noisy but harmless |

## Rollback

Unchanged from [releasing](../releasing.md) and the decision record: npm versions are deprecated and
fixed forward; under the proposed tag policy `X.Y.Z` image tags are never rewritten and `X.Y` and `latest` can move back to the last
good digest; data is protected by the backup the upgrade procedure requires first.
