# Milestone 2: client hardening

## Assessment

Medium-sized, High-risk follow-up to the approved milestone 2 plan and independent
Opus review. It touches CLI input/output and shared client credential handling;
no controller policy, schema or credential-file format changes. Work solo in
bounded steps, reviewed through the existing PR loop. Undo by reverting code;
existing credentials remain readable and no profiles are migrated.

## Goal and steps

1. Fail closed for a half-set environment credential pair unless an explicit
   profile was chosen. For project listing without a selected org, discover the
   key's organization; an explicit `LAUNCHPAD_ORG` remains an ID, not a slug.
   Test both behaviors and preservation of profile/environment precedence.
2. Bound actual key-file and stdin reads to 4096 bytes, including special files.
   Warn about permissive modes only for regular files. Refuse interactive
   `--key-stdin`, directing users to the hidden prompt. Strip terminal escape
   sequences and controls from terminal output/errors while preserving JSON
   formatting and existing key redaction. Test real files/devices and fake Io.
3. Remove time-based stale-lock stealing: age is not proof a writer is dead, and
   unlinking an observed stale path can delete a new owner's lock. Wait a bounded
   time then fail with `store-busy`; do not recover a stale lock automatically.
   Token-check release and clean failed temp writes. Test contention, ownership
   preservation, failed replacement and existing concurrent login behavior.

## Verification and risks

Run relevant Omni unit/type tasks, then the full check/test/build/compose gate and
an uncached Node-container check. No live controller, migrations or databases
needed. Fault-injection tests must restore filesystem mocks before cleanup.
The credential directory remains the trust anchor; a process running as the same
user can interfere with its files and is outside the security boundary.

Conservative locking trades automatic crash recovery for no silent profile loss.
Document manual lock removal only after the user confirms no client is writing.
Do not claim token comparison is an atomic filesystem compare-and-delete against
a hostile same-user process.

SDK real-network tests, password-reset policy, impossible key scopes and dashboard
implementation remain separate follow-ups in the dashboard plan.

## Progress

- PR #6 merged as `9b579e3`; started from clean main.
- Implemented; focused unit/type checks and the full Omni
  check/test/build/compose gate passed. An uncached Node-container
  check/test/build run also passed. Awaiting PR CI/review.
