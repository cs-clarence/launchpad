# Disposable routing and topology experiment

## Authorization and scope

The user explicitly authorized starting both disposable checks on 2026-11-19:
“Go start those checks.” This does not authorize production startup, publication,
DNS changes, or changes to the existing connectors.

This executes the High-risk experiment already specified in
`../decisions/immutable-deployment-alias-routing.md`. No application schema,
public API, or production routing is changed.

## Resource contract (recorded before creation)

Each run allocates a new `/tmp/opencode/lp-routing-<random>/` directory and writes
`resources.json` there **before** Docker resource creation. Container, network and
image names use that same run ID. Only two newly generated `lp-test-` apps are
deployed. Their names and deployment IDs are recorded before creation.

- One disposable Dokku, using `launchpad/dokku:0.38.34`, with a new state directory.
- One private bridge network shared by Dokku, worker, router and fixture proxy.
  Dokku also joins the default bridge to reach the app containers its host engine creates.
- One locally built worker image, running the real deployment adapters as UID 10001,
  with Docker-socket group access and a fresh artifact directory.
- One experimental Bun/SQLite router, not a production router implementation.
- One-off helpers have unique names recorded before creation, use `--rm`, and
  use tmpfs rather than the worker image's implicit anonymous artifact volume.
- Temporary test-only SSH/TLS/control credentials, never copied into evidence.
- No published host ports, real DNS, production environment files or connectors.

The response-loss preflight briefly opens two ephemeral **loopback-only** host
listeners and closes both before Docker setup. To run only that transport check,
also set `LAUNCHPAD_ROUTING_TRANSPORT_ONLY=1`; it is not a full routing pass.

The worker and Dokku have host-root-equivalent engine access, as in the approved
same-engine topology. The controller and PostgreSQL are not needed for these checks.
Cleanup removes only resources recorded by this run, verifies their absence, and
reports failures rather than pruning. Existing `launchpad-live-dokku` stays stopped.

## Acceptance

The topology check must build, load and probe two distinct fixtures from the
containerized worker through pinned SSH and Dokku's proxy, recording image IDs.
The router check must exercise every item in the decision record, including an
old-epoch request held **after authentication but before commit**. A passing
prototype demonstrates feasibility, not production readiness. Independent review
of code and evidence is required before immutable-model integration.

## Results

The first attempt (`lp-routing-qJUBx5`) stopped at the Dokku readiness check,
before worker/app/router creation. All named containers were verified absent
after cleanup. This is a harness/startup failure, not routing feasibility evidence.
The harness now retains the readiness error and Dokku startup log for diagnosis.
Further results will be recorded after execution.

The second attempt (`lp-routing-cLx2Re`) initialized Dokku and started the worker,
but Bun's module loader could not enumerate the mounted experiment directory
(mode 0711). It stopped before creating fixture apps or starting the router.
Cleanup verified all named containers absent. The harness now gives that fresh
directory mode 0755; private keys and router configuration remain mode 0600 and
owned by the container user. No production permissions were changed.

The third attempt (`lp-routing-pQf9os`) passed the worker/Dokku topology check:
UID 10001 built, streamed over pinned SSH, loaded and readiness-probed both
fixtures (`lp-test-37ad66`, `lp-test-dace9b`). It then stopped during the router's
response-loss fault injection: `node:http`'s `response.destroy()` under Bun did
not cause the client fetch to reject. The replacement destroys the underlying
socket and has a separate loopback preflight that verifies a real POST reaches
the origin before its response is lost. That preflight passes.

Both apps and their container/image tags, all named experiment containers, the
network and the worker image were verified absent after the third attempt.
Its credential-free topology log and fixture identities remain under
`/tmp/opencode/lp-routing-pQf9os/`. No complete router pass is claimed for that run.

The fourth attempt (`lp-routing-VkujHD`) passed topology and all core router
assertions (promotion/rollback, stale writes, 404s, real response loss, TLS Host/SNI,
and the authenticated old-epoch pre-commit race). It failed at restart because the
service command still included the bootstrap flag, which reran schema creation
against existing state. Initialization is now a separate one-off process; the
normal service command never creates state, so state loss cannot silently
reinitialize it. The core trace is retained under that run's `data/`; all fixture
apps, image tags, named containers, network and worker image were verified absent.

### Complete passing run: `lp-routing-nDukOy`

Command:

```sh
LAUNCHPAD_ROUTING_EXPERIMENT=1 omni -i run test:routing:experiment -p @launchpad-kit/tooling --output-logs all
```

The run passed in 217.2 seconds on 2026-11-19. Bun **1.4.4**, SQLite **3.53.4**,
Dokku **0.38.34**. Credential-free generated evidence is retained in
[`evidence/routing-20261119/`](evidence/routing-20261119/); the full temporary run
directory is `/tmp/opencode/lp-routing-nDukOy/`.

| Decision-record step | Observed result                                                                                                                                                                                                                                                        | Evidence                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1                    | Two distinct apps built, loaded and readiness-probed by the real worker adapters as UID 10001                                                                                                                                                                          | `fixtures.json`, `topology.log`                                                                                                         |
| 2                    | Both aliases, an extra unbound reservation and an unknown hostname returned exactly `404 Not found`                                                                                                                                                                    | `router-core.json`, `router-trace.ndjson`                                                                                               |
| 3                    | Independent aliases bound to A; one promoted to B and rolled back to A while the other stayed on A                                                                                                                                                                     | `router-core.json`, trace                                                                                                               |
| 4                    | Authenticated lower-generation bind and withdrawal held before commit, then rejected with 409 after a newer barrier. Actual stale-worker-claim testing is deferred and gates worker-lease integration; it is not verified here                                         | Trace: `/held`, `/release`, `/write`; generations above 2^53 are strings                                                                |
| 5                    | The response-loss proxy cut the actual TCP response after commit; authoritative read and identical replay recovered it. A separate driver exited 73 after the router acknowledged, before recording a completion; a new driver recovered/replayed its intent journal   | Trace phases `core`, `crash`, `crash-recover`; `router-crash-recover.json`                                                              |
| 6                    | Equal-generation/different-payload replay conflicted; withdrawing an unbound reservation at generation 8 fenced a generation-7 bind                                                                                                                                    | Trace; fixed-404 probe                                                                                                                  |
| 7                    | Restart retained bound route, tombstones, epoch and counters. The bound row is asserted; tombstone generations 2 and 8 and the rotated epoch are manually verified in trace line 63. Removing the durable pathname returned 503; starting without state exited nonzero | [Trace line 63](evidence/routing-20261119/router-trace.ndjson#L63), `router-restart.json`, `router-unavailable.json`; runner assertions |
| 8                    | Normal ingress proxy worked; upstream TLS received the immutable Host and SNI. A trusted-CA certificate with the wrong hostname was rejected with 502                                                                                                                  | `router-core.json`, trace                                                                                                               |
| 9                    | Ingress returned 503 while an older journal was restored, epoch/credential rotated and the restored counter raised above the authoritative counter. New state/epoch initialization rejected every old epoch/credential combination                                     | Trace, `router-lost.json`                                                                                                               |
| 10                   | A request held **after authentication and before commit**, with a generation larger than any observed value, returned 401 after rotation; authoritative routes remained structurally equal before/after release                                                        | Core trace and driver assertions                                                                                                        |
| 11                   | Both fixture apps, their container/image tags, five recorded long-lived container names (one reserved but unused), eight helpers, network and worker image were verified absent; temporary SSH/TLS/control secrets and router stores removed                           | `resources.json`, `cleanup.log`                                                                                                         |

There were **two fixture builds and zero promotion/rollback builds** in this run.
Dokku's deployed image identities before and after all routing changes are equal:

- A: `sha256:a59d750ecaa6566db8ff3339ed8d05d1400132bf4e5c019afa5de05b7f161827`
- B: `sha256:a829bfc7d6a49fd305f3746640801372388da7c5a7fc047e3715dd57be2df9e0`

`image-identities.json` records those comparisons and the worker/Dokku image IDs.
`fixtures.json` separately records the worker-built source identities, before
Dokku applies its own deployment image labels.

After cleanup, the existing `launchpad-live-dokku` was still stopped, and
`cloudflare-connector` / `playit-connector` were still running unchanged.
Synthetic artifacts and credential-free evidence are intentionally retained;
there is no experiment service left running.

**Independent review:** Opus 5.5 accepted the router-only generation/persistence
evidence, conditional on explicitly deferring/gating the real stale-worker-claim
test and citing the tombstone/counter restart trace. Both documentation conditions
are addressed above and in the decision record; no live rerun was requested.
Immutable-model implementation may now start, but worker-lease acceptance still
requires its own stale-claim test. This is not production-readiness approval.

The restore rehearsal records an older intended-journal snapshot; recovery uses
the authoritative router read, not that file as proof of an outcome. It does not
perform an application database restore. Ingress is closed at the fixture proxy.

Pulled/shared base images are retained, not included in the exact-name cleanup
inventory. No broad image/cache pruning is performed. The passing run used an
`alpine:latest` cleanup helper; the subsequently adjusted harness cleanup uses
its already-built worker image instead and reports removal failures without
discarding the original experiment error.

### Topology conclusion

The tested same-engine topology works: worker on a private user-defined bridge;
Dokku on that bridge for pinned SSH/proxy access and also on Docker's default
bridge to reach its app containers. Docker socket access is root-equivalent and
was confined to worker/Dokku. This test does not claim that the eventual Compose
file already expresses that dual-network provisioning; it must explicitly
preserve or separately verify the chosen app-network arrangement.

## Candidate limits

The candidate is a disposable single-process Bun/SQLite control/data plane with
`synchronous=FULL`, synchronous route/authority transactions, and authoritative
database reads on every data-plane request. Instance, alias ownership and immutable
upstream identities come from a fixed experiment inventory, never a public API.
The authenticated pre-commit gates and control fault proxy exist only to inject
failures. They are not production endpoints.

This does not verify application SQL pinning, retention races, worker leases,
public APIs, hostile-tenant resource isolation, replicas, certificate automation,
or power-loss/storage-hardware guarantees. It must not be wired into production
or represented as a hardened published router.

## Production router rehearsal

The accepted experiment above used a **prototype** router. This section repeats its scenarios against
the **production router image** (`apps/router`, built from the same commit as this record), on a new
disposable Dokku, with the same real worker adapters. It is run with
`LAUNCHPAD_ROUTING_REHEARSAL=1 omni -i run test:routing:experiment -p @launchpad-kit/tooling`, needs the
same explicit approval to start disposable services, and is not in CI. Credential-free evidence is in
[`evidence/router-rehearsal-20261119/`](evidence/router-rehearsal-20261119/) (the run directory was
`/tmp/opencode/lp-rehearsal-OWrG0V/`). It passed in 240.6 seconds: Bun **1.4.4**, SQLite **3.53.4**,
Dokku **0.38.34**; two fixture builds and zero promotion or rollback builds, and both deployed image
IDs were identical before and after (`image-identities.json`).

The production router has no fault hooks, so delays and response loss come from proxies around it
(`proxies.ts`), and an ordinary reverse proxy sits in front of the data plane.

| Scenario                         | Observed against the production router                                                                                                                                                                                                                          | Evidence                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Topology                         | The containerized worker built, loaded and verified both fixtures through pinned SSH                                                                                                                                                                            | `topology.log`, `fixtures.json`                         |
| Initialization                   | `init` from stdin created new state, printed only an epoch and refused to reinitialize                                                                                                                                                                          | `resources.json`, trace                                 |
| Fixed 404                        | Unbound, unknown and withdrawn aliases returned exactly `Not found`, never Dokku content                                                                                                                                                                        | trace, phases `core`, `lost`                            |
| Promotion and rollback           | Two aliases on A; one moved to B and back to A; the other never moved; no rebuild                                                                                                                                                                               | trace, `image-identities.json`                          |
| Delayed or lower generations     | Lower generations, equal generation with a different payload, and a bind below a withdrawal fence all returned 409 and changed nothing; generations above 2^53 are exact                                                                                        | trace                                                   |
| Response loss and a dying driver | A proxy cut the response after the router committed: an authoritative read showed the outcome, an identical replay was idempotent, a changed one conflicted. A driver exited 73 after the acknowledgement and its replacement recovered from its intent journal | trace (`lostResponse`), phases `crash`, `crash-recover` |
| Input and surface                | Out-of-domain, two-label, unknown-target, extra-field and malformed-generation writes were 400, an oversized body 413, no `rotate`, `init`, `held` or `release` endpoint existed (404), authentication failures were one fixed 401                              | trace                                                   |
| Hostile request forms            | Duplicate Host, absolute-form, bracketed IPv6, userinfo, trailing dot, POST and chunked GET were never served (404, 405 or 400)                                                                                                                                 | trace                                                   |
| Restart                          | Routes, tombstones, generations and the epoch were identical after `docker restart`                                                                                                                                                                             | `routes-core.json`, phase `restart`                     |
| Unavailable state                | With the state file moved under the running router every data and control request was a fixed 503, the healthcheck failed, and a router started without state **refused to start and did not recreate it**                                                      | phase `unavailable`, `cleanup.log`                      |
| Restore fencing                  | Ingress closed, router stopped, `rotate` ran, router restarted: every old epoch and credential combination was 401, routes were unchanged, an older journal entry was 409, and the next write raised the generation                                             | phase `restore`                                         |
| State loss                       | A fresh state in a new epoch rejected all 8 other epoch and token pairs and served nothing from the lost routes                                                                                                                                                 | phase `lost`                                            |
| Host, SNI, certificates          | Over https with a private CA the upstream received the registry hostname as both Host and SNI; a certificate for another name was a 502                                                                                                                         | phase `tls`                                             |
| Cleanup                          | Both fixture apps and their images, all seven containers, the three state volumes, both images, the network, fifteen helpers and all credential and state files were verified absent                                                                            | `cleanup.log`                                           |

**The harness can fail.** A second run against a router with its epoch check deliberately removed
failed in the first phase (a stale-epoch request returned 200 instead of 401), and the failure path
still removed everything by exact name. That mutant run is not part of the record.

**Not repeated here:** a write held _after_ authentication and _before_ its commit (the experiment's
step 10) needs a hook the production router rightly does not have. It is covered at the store level by
`packages/alias-router` (an authenticated handle fails after rotation, with an unseen generation), not
by this rehearsal. The stale-worker-claim case and application-database pinning remain gates of the
worker integration.
