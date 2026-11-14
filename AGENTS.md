# Agent instructions

Follow the guidelines in `docs/guidelines`. On a fresh checkout, run
`bun install && omni remote-sources install && omni projection sync`.

Run every task through Omni (`omni run check test build`); see `CONTRIBUTING.md`.
Read `CONTRIBUTING.md` for checks and Git workflow, `docs/tooling.md` for tooling,
and `docs/patterns/README.md` for package boundaries and current patterns.

## Artifacts

- Plans and assessments: `docs/plans/`.
- Design: `docs/design/`.
- Decisions: `docs/decisions/`.
- User docs: `docs/`, apart from `docs/guidelines`.

## Rules

- Commit, push, and open PRs only when asked. Never alter Git configuration,
  branch protections, or remotes.
- Do not start servers, containers, databases, migrations, or deployments unless
  explicitly requested. Bootstrap checks must not need live infrastructure.
- Do not edit projected guidelines/skills, generated route trees, or lockfiles by
  hand. Generator output is initial scaffolding and becomes hand-maintained.
- Update contributor/tooling/pattern docs in the same change when their commands,
  conventions, or example paths change.
