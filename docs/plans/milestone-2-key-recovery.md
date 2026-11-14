# Milestone 2: key recovery policy

## Assessment

Medium-sized, High-risk follow-up within the approved milestone 2 plan and Opus
review queue. Touches email-reset credential invalidation, key-issue input
validation, audit records and their existing callers/tests. No migration, new
identity flow, dependency or deployment behavior. Work solo; use CI/CodeRabbit
review before merging and retain the milestone's independent Opus review gate.

## Decisions and steps

1. Make emailed password recovery revoke the user's API keys, like operator
   recovery. Better Auth 1.7.23 calls `onPasswordReset` after its password/token/
   session transaction completes (observed in its installed password route and
   `resetCredentialPassword`). The callback deletes sessions again, then revokes
   keys in one transaction, preserving issuance's session-lock ordering. Audit
   afterward so a failing audit insert cannot undo completed revocation after
   the password has already changed. Never claim the callback and Better Auth's
   password change are one atomic transaction.
2. Include revoked-key counts in email and operator recovery audits. Log
   `api_key.deactivated` for active keys disabled by membership removal, in that
   removal transaction. Tests must show other users' keys are untouched and
   already-revoked timestamps are retained.
3. Reject `project:create` combined with project restrictions at issue time
   (422), while preserving the HTTP restriction for previously issued keys.
   Update contracts, service and HTTP tests together.
4. Correct stale role, plugin and `/me` descriptions; document the reset policy
   and failure limitations in the same change.

## Verification and undo

Run contracts/unit checks and full Omni check/test/build/compose plus disposable
PostgreSQL auth/services/controller integration. Verify email reset, audit failure,
operator-reset counts, removal auditing, valid/invalid scope combinations and
legacy restricted-key refusal over HTTP.

The existing sign-in versus password-reset session-creation race remains accepted;
this is not a credential-generation fix. If the callback's database work fails,
the email reset reports failure but its password/token change may already have
committed; operator recovery is the fallback. Successful reset must never leave
the old keys active. Revert code to undo validation/policy, but revocation already
performed is intentionally irreversible: issue replacement keys after recovery.

## Progress

- PR #8 merged as `19b420c`; clean main before this work.
- Implemented. Full Omni check/test/build/compose and PostgreSQL integration
  passed, including forced email-audit failure and legacy restricted-key cases.
  Awaiting PR review/CI.
