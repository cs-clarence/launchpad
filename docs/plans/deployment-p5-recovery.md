# P5: verified restore reconciliation and drift

Status: **proposed, awaiting approval. Nothing here is built.** Parent: [deployment model plan](deployment-model.md), P5.
Recovery design: [schema map](../design/deployment-cutover-schema.md#restore-and-the-recovery-gate). Drift design:
[deployment design](../design/deployment-modes.md) ("Drift detection"; the pure comparer is `packages/services/src/drift`).
P4 is merged: `recovery-clear` already compares the router's counters and unknown routes.

## Assessment

- **Kind / risk:** Large / High. It decides when a restored, possibly stale database may mutate again, so a false
  "verified" can lose a route change, leave traffic on a missing app, or let a delayed pre-restore write land.
- **Unknowns:** how a router that rotated, was replaced, or lost state looks to the comparer; what an operator can
  fix before the gate opens (promotions cannot run while it is closed); what can only be confirmed by a human (a
  still-running Dokku operation). Each gets a test against the real router on loopback and fake Dokku before the
  next slice builds on it.
- **Undo:** keep ingress closed and the gate set; retry. Never lower a counter.
- **Execution shape:** four PRs, solo build, independent Opus review before each push, CodeRabbit and CI before each
  merge. No live Dokku, Docker, DNS or production resource: the Dokku side is a fake client until P7, which needs your
  explicit authorization.

## Scope

1. **P5a: epoch anchor.** `restore` records the router's current epoch (not a secret) in the recovery marker (version 2).
   `recovery-clear` refuses unless the router's epoch now differs from it, so a rotation made after the backup but before
   the restore cannot pass for one made during recovery. A version-1 marker, or one recorded while the router was
   unreachable, has no anchor: clear then needs an explicit, audited `--router-epoch-unrecorded` (see decision 2).
2. **P5b: readers and `launchpad-admin drift`.** Read-only readers for the database snapshot (taken twice, findings
   that changed between the reads are dropped), the router (every page, tombstones included), the stored archives,
   optionally an identity probe, and Dokku through two new allowlisted reads (`apps:list`, `domains:report`). They feed
   the existing pure comparer. `--no-dokku` and `--no-router` skip a source (reported as skipped); an unreachable source
   is `unavailable`, never "no drift". Exit 0 clean, 1 findings, 2 a requested source unavailable. Advisory and
   operator-only.
3. **P5c: verified `recovery-clear`.** It runs the comparer under the maintenance lock and refuses on any blocking
   finding or required source that cannot be read. Blocking findings and their remedies:

    | Finding                                                                                     | Remedy while the gate is closed                                                                                                                                            |
    | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `router-epoch-mismatch` (router not rotated)                                                | `router rotate` (managed), update the credential files. **Never acceptable.**                                                                                              |
    | `alias-router-ahead`, `router-unknown-route` (live)                                         | `recovery-raise-counters`, `recovery-withdraw-unknown` (P4e). **Never acceptable.**                                                                                        |
    | integrity alarms (`reservation-without-owner`, `owner-without-reservation`)                 | Stop and investigate. **Never acceptable.**                                                                                                                                |
    | `alias-router-behind`, `alias-route-missing`, `alias-target-conflict`                       | New `recovery-republish-alias`: the restored database is authoritative, so write its committed target to the router at a generation above the router's, then read it back. |
    | `deployment-app-missing`, `deployment-domain-mismatch`, `archive-missing`, `probe-mismatch` | Fix on the host, or accept explicitly (below).                                                                                                                             |

    `--accept <code>:<id>` (repeatable, audited with the finding and operator, never for the "never acceptable" rows)
    lets an operator clear while a finding remains whose remedy needs the normal API, for example promoting another
    deployment after reopening. Medium findings (`orphan-app`, `stuck-operation`, `unreferenced-pin`) are reported and
    never block; orphan apps are never deleted. The broad `--i-have-reconciled-router-and-dokku` attestation is
    removed (decision 1).

4. **P5d: gate coverage and rehearsal tests.** A test that, with the gate set, calls every mutating service entrypoint
   and every mutating HTTP route and expects refusal, and that the gate survives a restart. A loopback scenario with the
   real router for: router ahead, unknown target and alias, missing tombstone, epoch mismatch, lost router state (fresh
   router bootstrapped offline, never an HTTP epoch reset), and repeated interrupted recovery. Docs: restore, install,
   upgrade, tooling, design status.

## Decisions to approve

1. **What replaces the attestation.** A human must still confirm what no program can see: that no Dokku operation
   dispatched by a pre-restore writer is still running. I propose removing the broad flag and requiring (a) at least
   25 minutes since the marker's `restoreStartedAt` (the worker's documented stop grace, checked by the command) and
   (b) one narrow flag, `--i-have-checked-the-dokku-host`, for the host check in the runbook. Alternative: keep the
   existing flag unchanged. Say which.
2. **Restore with the router unreachable.** `restore` still proceeds (a restore is an emergency) and records no anchor;
   `recovery-clear` then needs `--router-epoch-unrecorded`, audited, and still compares everything else. Alternative:
   refuse to restore until the router answers.
3. **The restored database is authoritative.** `recovery-republish-alias` overwrites the router's disagreeing route with
   the database's, so a promotion made after the backup is undone (it was already lost by restoring). Alternative: also
   offer adopting the router's route into the database.
4. **Explicit acceptance.** `--accept` exists for the non-safety findings above. Alternative: no acceptance; every high
   finding must be remedied before the gate opens.
5. **Dokku reads.** Two new read-only allowlisted operations in the Dokku client (`apps:list`, `domains:report <app>`),
   exact-name or fixed-shape, bounded output and time, fake in tests.

## Risks

| Risk                                              | Control                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| False "verified" from a partial read              | Every page checked for instance and epoch; any unreadable required source refuses; snapshot taken twice.     |
| A delayed pre-restore write lands after the clear | Epoch anchor plus the existing fence; the maintenance lock excludes writers during the read.                 |
| Operator accepts something unsafe                 | A fixed list of unacceptable findings, each acceptance audited, nothing deleted.                             |
| Republish writes a wrong route                    | Database authoritative by design, written at a higher generation, read back and probed, audited, idempotent. |
| Unprovable Dokku settling                         | Time bound checked by the command, host check confirmed by one narrow flag.                                  |

## Verification

Each slice: `omni -i run check test build test:integration` on disposable PostgreSQL (stopped afterwards), the real router
on loopback and a fake Dokku, independent read-only review before each push, CodeRabbit and CI before merge.
