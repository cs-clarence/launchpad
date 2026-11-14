# CLI

For contributors to the Bun-based `launchpad` CLI. Keep this page current when
commands change.

`src/index.ts` currently provides help/version only. Deployment, login,
configuration storage, and controller communication are not implemented.
The CLI will call the controller rather than invoking Dokku directly.

Build and check commands are in [CONTRIBUTING.md](../../CONTRIBUTING.md).
