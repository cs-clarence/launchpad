# TypeScript scaffold

Copied from [Pureform](https://github.com/pureform-design/pureform), commit
`70232808fa9190da9733510d4efc0d272fa2abe6`, `omni/generators/ts-package`.
The upstream MIT notice is in `LICENSE`. This is a project-owned derivative,
not an automatically updated vendor snapshot.

Launchpad changes: default scope/version/runtime, private workspace manifests,
explicit package scripts, source type exports, and an adapted root Cocogitto
configuration. `release_group=core` appends the package glob to the shared core;
`binding` and `tooling` register independent packages in `cog.toml`. The default
`none` leaves release configuration unchanged.
The root config deliberately omits Pureform's version-update script and
automatic tag pushes. Version/lockfile synchronization must be added before
using it to release packages.
App scaffolds requesting unit tests also receive the example module those tests
import.

Keep templates and their supporting workspace config packages in sync.
Generated scaffolding is hand-maintained after creation; route trees and
build output remain generated.
