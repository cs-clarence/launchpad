# Production preparation: PostgreSQL client options

For maintainers continuing slice 3 of [production Compose](production-compose-follow-up.md).
The user's instruction to continue production preparation authorizes this code-only slice,
not production startup, deletion or a live database drill.

## Scope and risk

Medium-sized, High-risk connection-security fix within the existing approved direction.
`pgEnvironment` currently drops every query option except `host` and `sslmode`.
Preserve PostgreSQL 17 TLS options with documented libpq environment equivalents;
reject unknown, duplicate and empty options, including options without an environment
equivalent, instead of silently changing connection policy. Keep credentials out of
arguments and error messages. Do not change the Bun database connection, router TLS,
restore fencing or Compose topology.

## Steps, checks and undo

1. Add listener-free unit coverage for certificate paths, protocol settings,
   URL decoding, unsupported/ambiguous input and secret-free errors.
2. Implement the allowlist shared by dump and restore; validate backup settings
   before database access or destination creation. Restore already parses settings
   before creating its pool or changing database state.
3. Document the exact option contract and remaining limits in the operator docs.
4. Run the full Omni check/test/build and Compose-render gate and self-review.

Undo: revert this code/document change; no stored state is changed by these checks.
Live certificate verification and backup/restore remain separately authorized
integration checks. This slice proves translation and refusal, not end-to-end TLS
compatibility between Bun SQL and libpq.

## Verification record (2026-11-22)

The new regression tests failed against the original adapter, then passed after
the change. The uncached full Omni check/test/build and Compose gate passed
(subsequently rerun with the router TLS task: 100 enabled tasks passed, one
disabled database unit task skipped).

Independent read-only security review found no blocking findings in the
allowlist/refusal behavior. The reviewer inspected code but did not rerun checks.
Live PostgreSQL TLS backup/restore, including Bun SQL/libpq compatibility, remains
unverified. No production database or stored state was changed.
