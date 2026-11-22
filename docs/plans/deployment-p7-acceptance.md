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

## Public app ingress smoke (2026-11-22)

The separately authorized wildcard smoke passed in 204 s. It ran built
Launchpad images with disposable PostgreSQL and Dokku; only two deployment
hostnames and one alias were served through the temporary `127.0.0.1:9080`
listener. Both immutable URLs returned 200 with the same deployment identities
before and after promotion. The alias returned A's identity, then B's, then
404 without an identity after withdrawal. An unmatched local host returned 404.
The fixture inventory was cleaned up and port 9080 was verified closed.

This verifies public app traffic against the rehearsal topology, not production
Compose or private router-control TLS. The wildcard and connector were not changed.

## Hardened full-stack rerun (2026-11-22)

The same full-stack command passed S1–S14 in 1,205 s with six race rounds and
real lease expiry. This rerun used the hardened assertions and cleanup, with
no public ingress or published ports. The raw evidence and resource inventory are
separate from the original run, in `/tmp/opencode/lp-accept-ZiCrTP/`.

- S8: promotion won all six races and deletion was refused every time. There
  was no double acceptance, but this rerun did not exercise the tightened
  Dokku-absence assertion on the deletion-wins branch. The original run saw
  both outcomes.
- S12: the delayed write returned 409; the newer route and database snapshot
  stayed unchanged and the worker ended `authority-lost`. This still does not
  exercise an attempted stale SQL mutation.
- S13 dropped two successful router replies and verified that an uncertain correction
  retains the original candidate's pin until a second correction settles both
  ancestors. It uses two targets: `promotion-reconcile` permits only targets already
  in the held chain, so the original worked example's correction to a new third
  target would require a product change.
- S14 verified the router tombstone and 404 after shutdown withdrew the alias.
  Deletion was queued only on a later request, and both fixture apps were removed.

The inventory and cleanup log show no fixture containers, networks, volumes,
image tags or secret/state paths left behind. Only the two pre-existing connector
containers remained.

## PostgreSQL integration

The new PostgreSQL integration cases check that changing the domain and hostname
template affects only future deployment and alias allocations. They do not test
live traffic across a domain cutover. The services suite passed on disposable
PostgreSQL (`omni -i run test:integration -p @launchpad-kit/services --force all`);
the fixture container was removed and verified absent.

## End-to-end restore result (2026-11-22)

The isolated drill passed S1–S2 and R1–R4 in 2,038 s with no published ports.
It restored the generation-1 backup (A) while the live router still served B
at generation 2. Managed rotation invalidated the old router credentials
(HTTP 401). Republish and clear both refused before the recovery deadline.
After 1,501,045 ms from the recorded restore start, republish restored A at
generation 3. The authenticated API still returned 503 for a promotion.
`recovery-clear` succeeded without overrides, removed the marker, and the
resumed worker committed generation 4 and served B.

Evidence and exact-name cleanup are in `/tmp/opencode/lp-accept-wqaOme/`
(`evidence.json`, `resources.json`, `cleanup.log`). No fixture resources
remained; only the two pre-existing connectors were present. This exercised
the disposable topology, not production Compose or management ingress.

## Still open

- Scheduled GC waiting for the later deadline (automatic expiry is not built).
- The held-after-authentication router write (covered in `packages/alias-router`).
- CI and verification of the review follow-ups. Independent review identified
  cancellation, Dokku settlement, ingress 404 provenance and separate stale
  token/epoch checks; the harness now checks each explicitly. The results above
  predate those review changes.

## Repeat the restore drill against a newer router

**Assessment:** Medium change, medium risk. This adds a solo, opt-in harness
mode without changing product code or touching installed state. The main unknown
is how backup, live epoch anchoring and managed rotation compose when run from
the built images. Fixtures can be removed by exact inventory; expect at least
30 minutes of timed waits. Check the harness with Omni, then run the live drill
and verify its cleanup. Any required product fix is a separate change.

Use an isolated variant of the full-stack fixture. Add the built `admin` image,
a second fixture database owned by the runtime role and a backup directory to the
resource inventory. Keep the original database intact. Use the real admin
commands and managed router rotation from the [restore runbook](../restore.md).
No production credentials, Cloudflare, public ports or existing Dokku state.

Run with
`LAUNCHPAD_ACCEPTANCE_REHEARSAL=1 LAUNCHPAD_ACCEPTANCE_RESTORE_DRILL=1 omni -i run test:acceptance:rehearsal -p @launchpad-kit/tooling`.
It runs S1–S2 for setup, then R1–R4 instead of the rest of the full rehearsal.

The first attempt passed S1–S2 and R1, including verified backup creation and
promotion from generation 1 to 2. It stopped before restore because `docker top`
requires the PID column to filter the host process list. Cleanup was verified
(`/tmp/opencode/lp-accept-pNRXZO/`); the corrected drill reruns the same host check.
The second attempt passed restore and API blocking, rotated the router and raised
the counter. It found that republish also requires the recovery wait. The fixtures
were removed (`/tmp/opencode/lp-accept-d01osa/`); the drill now tests both refusals
and republish runs after the wait.

1. Deploy A and B and bind one alias to A. While fixture mutations are quiescent,
   create and verify a matched backup. Then promote the alias to B and record the
   router's newer generation and served deployment ID.
2. Stop fixture writers, wait 301 seconds and check the Dokku host before running
   `restore` into the empty database. Keep the fixture router readable during
   restore so the marker captures its actual epoch. Verify schema status and
   run `check-restore` against Dokku. Start only the restored controller on the
   fixture network. Assert that an authenticated model mutation is refused while
   the router still serves B and the database still records A.
3. With writers still stopped, stop the router and rotate it using the restored
   fixture database's managed lock. Update only the fixture credentials. Verify
   the old credentials are refused and the new authority still observes B.
   Raise counters and verify both republish and clear refuse before the minimum
   wait. The router must still serve B and the API must still refuse model writes.
4. Wait the full 25 minutes from restore start and confirm no pre-restore Dokku
   work is still running; do not edit the marker or advance the clock. Republish
   A above both generation fences and verify it through both router planes.
   Confirm the API still refuses writes until running
   `recovery-clear` without accepting any drift. Start the worker against the
   restored fixture and promote to B once more. Require a generation above the
   republished route and verify B is served.

Record the gates, epochs, generation sequence and served identities without
credentials. If a check fails, leave the gate closed and remove only the recorded
fixture resources; use the pre-restore database and router observations for
diagnosis, not as a reason to reopen writes. This is separate from the
six-round acceptance run and the production Compose cutover.

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
