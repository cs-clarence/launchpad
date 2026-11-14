# Provenance of the CI configuration

The workflows and actions here are project-owned derivatives, not automatically
updated vendor snapshots. Both sources are MIT licensed; their notices are kept
next to this file.

- `workflows/ci.yaml` and `actions/setup-workspace` are adapted from
  [Pureform](https://github.com/pureform-design/pureform) at commit
  `70232808fa9190da9733510d4efc0d272fa2abe6` (`.github/workflows/ci.yaml`,
  `.github/actions/setup-workspace`; last changed in `fe96102d`). License:
  [LICENSE-pureform](LICENSE-pureform).
- The `ci-gatekeeper` job follows [Omni](https://github.com/omni-oss/omni)
  `.github/workflows/ci.yaml` at commit `be1bc99632ff33032a9b9cea7fdd18a54a36e95a`
  (last changed in `59bc510b`). License: [LICENSE-omni](LICENSE-omni).

Launchpad's changes: Playwright and browser-test jobs, build-artifact packaging,
the sharded test matrix and publishing are removed (no browser tests, no
publishing yet); jobs run this repository's Omni tasks, including an
`integration` job that starts a disposable PostgreSQL with `omni run test:db:up`;
and the gatekeeper is stricter, requiring every job in the static set to be
exactly `success` (see the comment in `workflows/ci.yaml`).
