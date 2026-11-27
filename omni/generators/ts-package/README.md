# TypeScript scaffold

Copied from [Pureform](https://github.com/pureform-design/pureform), commit
`70232808fa9190da9733510d4efc0d272fa2abe6`, `omni/generators/ts-package`.
The upstream MIT notice is in `LICENSE`; it stays as third-party attribution for the
derived scaffold, while generated packages default to `Apache-2.0` (`package_license`). This is a project-owned derivative,
not an automatically updated vendor snapshot.

Launchpad changes: default scope/version/runtime, private workspace manifests,
explicit package scripts, source type exports, and an adapted root Cocogitto
configuration. `release_group=core` appends the package glob to the shared core;
`binding` and `tooling` register independent packages in `cog.toml`. The default
`none` leaves release configuration unchanged.
The root config deliberately omits Pureform's version-update script and
automatic tag pushes. Version/lockfile synchronization must be added before
using it to release packages.
A published CLI never bundles its dependencies: a `script` with `published` set (or one that can
be used as a library) externalizes every declared dependency, and is built as `dist/cli.mjs`,
named by `bin_name`, else the package name (an object `bin`, so the command is not forced to be the package name). A published script always gets the `node` shebang: `published` is asked first, and `shebang_executor` is only asked for a script that is not published (a validator cannot see other inputs; the templates default it to `node`). A plain
`script` that is not published may still bundle. A script that is not a library has no `index`
entry. Set `published` only when a publish step exists: in this repository `published` makes the
source manifest non-private, and the apps (`apps/cli`, `apps/mcp`) stay private and are packed
from a generated manifest instead (see `docs/releasing.md`). The CLI template imports only
`@commander-js/extra-typings`; `commander` is declared as its peer and never imported
(`omni -i run check:imports`). The template reads `package.json` with a JSON import, which a
bundler inlines whole into the output: do not copy that into a published CLI.
A generated package has no `LICENSE` file of its own (the generator's MIT `LICENSE` is attribution
for the scaffold and is never copied). It becomes publishable only by adding it to `TARGETS` in
`tooling/package-clients.ts`, which copies the root Apache-2.0 `LICENSE` into its tarball and
fails the pack without it; `package_license` only sets the manifest field.
A `published` package also gets `repository` (with `directory`, the package's path from the
workspace root), `homepage` and `bugs`, written from a constant in the template, not an input, so it cannot differ from `REPOSITORY_URL`
in `tooling/package-clients.ts`; moving the repository means editing both. The packed manifest does not copy them: it is built
by `stage()` from `REPOSITORY_URL` in `tooling/package-clients.ts`, and npm trusted publishing needs
that `repository.url` to match the GitHub repository exactly.
App scaffolds requesting unit tests also receive the example module those tests
import.

Keep templates and their supporting workspace config packages in sync.
Generated scaffolding is hand-maintained after creation; route trees and
build output remain generated.
