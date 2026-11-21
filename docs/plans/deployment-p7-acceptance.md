# P7: acceptance record (partial)

Authorized by the user on 2026-11-21 ("Full P7"): disposable PostgreSQL, Docker image
builds and a disposable Dokku, exact-name fixtures only. No production startup,
publishing, DNS or connector changes.

## Full-stack rehearsal (2026-11-21)

`LAUNCHPAD_ACCEPTANCE_REHEARSAL=1 LAUNCHPAD_ACCEPTANCE_RACE_ROUNDS=6 omni -i run test:acceptance:rehearsal -p @launchpad-kit/tooling`
passed in 1008 s: the built controller, worker and router images, a disposable PostgreSQL 17 and
`launchpad/dokku:0.38.34`, no published ports. Evidence:
[`evidence/p7-acceptance-20261121/`](evidence/p7-acceptance-20261121/) (`evidence.json` per
scenario with its mechanism, `proxy-log.json`, `resources.json` recorded before creation,
`cleanup.log`). Harness: `tooling/experiments/acceptance/`. Cleanup verified every recorded
container, helper, network, volume, image and fixture app absent; `docker ps -a` shows only
`cloudflare-connector` and `playit-connector`.

Fixture cleanup checks exact app labels and image tags on the shared host Docker
engine, derived from this run's own database. Unlike the Compose rehearsal, this
harness uses a tag-only PostgreSQL image and a local Dokku tag whose build
provenance is not verified by the harness.

After this run, PR review tightened the harness's assertions and cleanup. The
checked-in evidence remains the original run, not a rerun of the hardened harness.

| Scenario                                                                                                                                                                                  | Result | Mechanism beyond the HTTP API                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------- |
| S1 upload once (second upload reused)                                                                                                                                                     | pass   | SQL count                                                                       |
| S2 deploy A and B: distinct Dokku names/hostnames, one artifact                                                                                                                           | pass   | SQL, Dokku probe                                                                |
| S3 bind production and staging to A                                                                                                                                                       | pass   | router read, data-plane probe                                                   |
| S4 promote only production to B                                                                                                                                                           | pass   | same                                                                            |
| S5 roll back to A: image and container IDs identical, no new deployment run                                                                                                               | pass   | docker inspect, worker log                                                      |
| S6 failed candidate C leaves aliases, routes and A untouched                                                                                                                              | pass   | archive damaged via a root helper on the shared data volume                     |
| S7 two concurrent promotions: statuses 202 and 409, one operation                                                                                                                         | pass   | SQL count                                                                       |
| S8 promotion vs deletion, 6 rounds: deletion won 2, pin won 4, never both                                                                                                                 | pass   | SQL, `apps:exists`                                                              |
| S9 withdraw one of two aliases: A stays pinned, DELETE 409                                                                                                                                | pass   | SQL pins                                                                        |
| S10 final withdrawal releases the pin, sets `last_unpinned_at`; manual DELETE accepted inside the retention window                                                                        | pass   | SQL                                                                             |
| S11 lost acknowledgement: both targets pinned, deletes 409, new promotion 409, until operator readback                                                                                    | pass   | proxy drops the router's reply; `promotion-reconcile`                           |
| S12 stale worker (real 300 s lease expiry): delayed write answered 409, router keeps the newer generation, database snapshot (including `xmin`) unchanged, worker 1 ends `authority-lost` | pass   | proxy holds the authenticated write; `docker pause`; worker 2; SQL; router read |

Limits of what S12 proves: the resumed worker stopped through its own lease check and
issued no mutating statement that `log_statement=mod` recorded (`{}`), so the zero-row
SQL fence on an actual stale write is still covered only by the PostgreSQL tests
(`packages/services`, `apps/worker`), not exercised here. The held write was forwarded to
the router after worker 2's correction, as a delayed packet. In S11 and S12 the
correction is the operator `promotion-reconcile` command; the stale operation is held by
worker 2's normal claim, not failed. Pins in SQL are read with the definition in
`packages/services/src/pins.ts`.

## Production Compose rehearsal (2026-11-21)

Separately authorized: one disposable instance of `docker-compose.yaml` (deployments on, aliases off).
Result and evidence: [`evidence/p7-compose-20261121/`](evidence/p7-compose-20261121/README.md). It does
**not** exercise alias routing: `LAUNCHPAD_ALIASES=on` is refused with this Compose topology (the router
control URL must be HTTPS or loopback), so the acceptance scenarios above remain proven only by the harness
topology, not by the Compose stack.

## Not exercised

- Scheduled GC waiting for the later deadline (automatic expiry is not built).
- Supersession chains of two corrections, restore with a newer router, domain/template
  change affecting only future allocations, app shutdown.
- The held-after-authentication router write (covered in `packages/alias-router`).
- Independent Opus review, CodeRabbit and CI; nothing was committed.

## Earlier record, `main` at eb7dd4f

### Gates

Run on `main` at eb7dd4f (P6), all passed:

| Gate                                                                                                  | Result                                                                                 |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `omni -i run check test build`                                                                        | passed                                                                                 |
| `test:db:up`, then `test:integration`, `test:images`, `test:upgrade`, `test:packages` (`--force all`) | passed, 285 s; disposable PostgreSQL removed by `test:db:down`                         |
| `LAUNCHPAD_ROUTING_REHEARSAL=1 omni -i run test:routing:experiment`                                   | passed, 230 s: production router image, real worker adapters, disposable Dokku 0.38.34 |

Rehearsal run directory `/tmp/opencode/lp-rehearsal-nXFAdT/` holds `resources.json` and
`cleanup.log`; every recorded container, helper, network, image and fixture app was
verified absent. `cloudflare-connector` and `playit-connector` were untouched.

Undo: exact recorded fixture cleanup only (complete).
