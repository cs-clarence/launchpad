# Releasing Launchpad

For a maintainer preparing a release. **Nothing in this repository publishes, pushes,
tags or releases by itself.** The rehearsal below is read-only; real publishing needs a
separate, explicit authorization and a workflow that does not exist yet.

## Versions

One version covers everything that ships together: the root manifest, every package under
`packages/` and `apps/` (including the controller and worker images, which carry the same
number), except the shared tooling packages (`@launchpad/tsconfig`, `vite-config`,
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
  message carries `[skip ci]`; run the checks before bumping, not after.
- `from_latest_tag = false`: with no earlier tag the first changelog covers all history.
  Tag a baseline first if that is not wanted.

## What a release contains

| Artifact                                                  | Built by                           | Checked by                         |
| --------------------------------------------------------- | ---------------------------------- | ---------------------------------- |
| `@launchpad/contracts`, `sdk`, `cli`, `mcp` tarballs      | `tooling/package-clients.ts`       | `test:packages`, the dry run       |
| Controller and worker images                              | `containers/*/Dockerfile`          | `test:images`, the dry run (build) |
| Database migrations (forward-only, bundled in the images) | `packages/database/src/migrations` | `test:integration`, `test:upgrade` |
| Operator documentation                                    | `docs/`                            | review                             |

The `@launchpad/*` package names are placeholders until the npm scope and product name are
decided; renaming them is one change. Packed READMEs are still developer documentation and
the manifests have no `license` or `repository`; both wait on those decisions.

## Rehearse a release

```sh
omni -i run release:dry-run -p @launchpad/tooling
```

or run the manual **Release dry run** workflow. It checks that versions agree, packs the
four client packages with the same allowlist checks as `test:packages`, writes
`packages/SHA256SUMS`, builds both images **without pushing them**, removes those images by
exact name, and leaves everything in `.release-dry-run/` (kept 7 days as a workflow
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

**SDK and contracts** (`@launchpad/sdk`, `@launchpad/contracts`). The exported names, their
types and the schemas' accepted and produced shapes are the interface. Breaking: removing
or renaming an export, narrowing a parameter type, widening a returned type a caller
narrows on, changing an error class a caller catches. Adding exports and optional fields is
compatible. A change to a schema that the REST API uses follows the REST rule too.

**MCP tool list** (`apps/mcp/src/server.ts`). Tool names, their input schemas and the shape
of their results are the interface an agent depends on. Breaking: renaming or removing a
tool, removing or retyping an input or a result field, making an input required, or changing
what a tool is allowed to do (the read-only set and the two mutating tools, `deploy` and
`delete_preview`, stay opt-in). New tools and new optional inputs are compatible. Any new
mutating tool is a **security-relevant** change: it needs its own review and release note.

**CLI** (`launchpad`). Command names, flags, exit codes and the documented output of
`--json` modes are the interface; human-readable text is not. Breaking: removing or renaming
a command or flag, changing an exit code or a machine-readable field. Credentials are never
accepted as arguments; that does not change.

**Database and operator commands.** Migrations are forward-only and run only by
`bun .output/admin.mjs migrate`; rollback means restoring the pre-upgrade backup. A release
must upgrade from the previous release's schema (the frozen fixture in
`apps/controller/src/admin/__tests__/fixtures/` is extended with each release's dump).
Breaking: a migration that cannot run on the previous release's data, a changed backup
manifest format without reading the old one, a renamed or removed admin command or option, a
changed configuration variable name or meaning, or a change to the fixed uid, data
directory layout or required mounts of the images. State each in the upgrade notes.

## Release checklist

A release is a person's decision. Work through this in order and stop at the first failure.

1. `main` is green: `CI Passed`, and the full local gate
   `omni -i run check test build check:compose test:integration --force all`
   plus `omni -i run test:upgrade -p @launchpad/controller` on Linux.
2. The previous release's database schema is in the upgrade fixture and `test:upgrade`
   passes from it; `docs/upgrade.md` and `docs/restore.md` match the commands.
3. Every breaking change since the last release is listed against the rules above, and the
   version increment fits them. Security-relevant changes have a release note.
4. Licence, npm scope and product name are decided and recorded; the packed READMEs and
   manifests carry `license` and `repository`; **registry ownership of the name is verified
   with an authenticated account**. (Not done: all three are open decisions.)
5. Base images in `containers/*/Dockerfile` are pinned by digest, not tag.
6. Run the [dry run](#rehearse-a-release); inspect the tarball listings, `SHA256SUMS` and the
   image notes. No `.env`, key, source map or workspace specifier in any tarball.
7. `cog bump` on a clean checkout, then review the bump commit, changelog and tag locally.
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
