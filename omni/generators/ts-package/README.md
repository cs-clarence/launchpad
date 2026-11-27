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
App scaffolds requesting unit tests also receive the example module those tests
import.

Keep templates and their supporting workspace config packages in sync.
Generated scaffolding is hand-maintained after creation; route trees and
build output remain generated.
