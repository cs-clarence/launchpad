# Generation-checked deployment alias routing

Date: 2026-11-19.
Status: **selected design direction; router-only feasibility accepted after independent review**.
Related design: `docs/design/deployment-modes.md`.
Experiment authorization, attempts and evidence: `docs/plans/routing-experiment-evidence.md`.

## Context and decision

Each deployment has one immutable Dokku app and unique hostname. Several stable
aliases may independently refer to it. Promotion must not rebuild the image or
reconfigure the immutable Dokku app. A SQL fencing token cannot stop an old SSH
command or delayed router update from altering live traffic.

Use a dedicated alias-router control/data plane with persistent generation-checked
route replacement. Public ingress, Tailscale and tunnel products remain external,
configurable ways to reach that data plane—not prerequisites of the application.
The router control endpoint is private, authenticated and accessible only to
authorized worker/admin processes. The controller has no generic proxy/Dokku
configuration execution surface.

No router product or implementation has been selected yet. Slice 1 must select
one that demonstrably supports the contract below; this record does not assert
that a default reverse-proxy configuration already provides those guarantees.

### Alternatives

- **Dokku domain attach/detach:** fewer services, but no atomic two-app cutover or
  remote stale-writer fencing in the current allowlisted client. Rejected for
  this first implementation; adding commands would not solve those guarantees.
- **Database pointer only:** simple transaction, but unchanged remote routes may
  disagree and stale workers may still write. Rejected.
- **Generation-checked router:** extra service, persisted state, authenticated
  control surface and recovery procedure. Selected because those costs buy a
  verifiable fencing and cutover boundary rather than optimistic SSH sequencing.

## Required control contract

All writes include authenticated instance ID, router epoch, reservation/alias ID,
hostname, UUID operation ID, desired generation and target (or fixed-404 tombstone).
Generation is a decimal bigint string. Payloads are bounded and canonicalized.
Targets are deployment identities whose immutable hostnames the backend owns;
never accept arbitrary client URLs, headers, private IPs or proxy directives.

- Per hostname/reservation, atomically apply a generation **higher** than the
  observed one; gaps are permitted. Replaying the same operation/generation with
  identical contents is idempotent. Equal generation with different contents or
  any lower generation is a conflict and changes nothing.
- The router learns a hostname on its first authenticated bind or withdraw write,
  which supplies the instance-owned reservation and has generation at least 1.
  Backend alias creation reserves generation 0 only in its own DB: until that first
  router write, the router treats the host as unknown (fixed 404), indistinguishable
  from unbound. Withdrawing an unbound alias still writes and verifies a tombstone,
  fencing delayed binds. Unknown epoch, unauthorized hostname or unrecognized
  instance fails closed. Public app APIs cannot supply arbitrary hostnames.
- Return the observed epoch, operation, generation and target from an
  authoritative read. Never infer success solely from a TCP connection, an HTTP
  200 on a control request or absence of an SSH error.
- Validate the epoch and credential **atomically with the route commit**, not only
  when the request is authenticated. A write the router accepted before an epoch
  change or credential rotation but has not yet committed must be rejected,
  leaving the route and authoritative read free of any state from that operation.
- Acknowledge success only when the route decision is persisted and active.
  Each incoming request chooses one complete mapping (old or new), not a partial
  configuration; existing requests may finish on the old target. Propagation across
  multiple router replicas is out of scope initially; use one authoritative
  router instance and test its restart behavior.
- Tombstones retain generations and hostname ownership. Unbound, unknown and
  withdrawn hosts return a fixed 404 with no upstream selection. Lost state must
  not fall back to Dokku, another app or an old route cache.
- No timeout may be treated as proof a mutation did not happen. A DB lease/attempt
  fences local writes; router generation fences remote writes. Abandoning a
  dispatched operation requires observing its outcome or applying and verifying
  a higher-generation corrective barrier. Keep both possible targets pinned.

The data plane passes the immutable deployment hostname as upstream `Host`.
Where the upstream uses TLS, SNI and certificate verification use that same
trusted hostname; never disable verification to make aliases work. Certificate
management for external domains and public ingress is out of scope.

## Restart and restore

Normal restart reloads the durable mapping/tombstone store before accepting
traffic. Unavailable/unreadable routing state produces a controlled error, not
cross-app fallback.

A controller database restore forgets every route write issued after its backup,
including one still in flight or delayed. Under an unchanged epoch that write stays
valid and could later route traffic to a deployment the restored database neither
knows nor pins. A per-host generation barrier cannot cover it: the router has not
seen that write, so no barrier can safely exceed its unknown generation.

**After every database restore, fence all pre-restore writers before reopening
ingress or any mutation.** Establish a new router epoch and rotate the control
credentials together, then verify the router rejects the old epoch/credential pair.
Only then inspect the router's authoritative routes and reconcile them with the
restored database. Routes absent from it are not trusted: pin their deployments,
withdraw them or record them for operator review; never replay restored low
generations blindly. Route generations themselves are not reset: a new epoch fences
the old senders while keeping acknowledged generations and tombstones. If routing
state is lost, establish the new epoch and credentials and rebuild routes offline
from a reviewed inventory. Close ingress and disable mutations and GC throughout.

## Disposable experiment specification

**Not executed by drafting or approving the document alone.** Obtain explicit
approval to start the named disposable services. Record unique project/container/
volume/app names before creation; use only newly created `lp-test-` Dokku apps,
temporary credentials, pinned SSH trust and non-conflicting loopback ports.
Do not adopt `view-demo`, normal Dokku, production `.env.local`, or existing
Cloudflare/Playit connectors. No real DNS or public routing changes.

1. Build/deploy fixtures A and B once into separate apps; response bodies expose
   distinct deployment IDs. Record image IDs before promotion.
2. Create two alias reservations. Before binding, probe each and an unknown Host:
   all return fixed 404 with no fixture content.
3. Bind both aliases to A, promote one to B, then roll it back to A. Probe after
   each acknowledgement. The other alias never changes; neither image rebuilds.
4. Delay a lower-generation write, apply a newer generation, then release the
   delayed write. The old request must conflict and data-plane probes must remain
   on the newer target. Repeat with a delayed withdrawal. The actual stale-worker-claim
   case is deferred to, and gates completion of, the worker-lease integration:
   a superseded claim must not undo a confirmed higher-generation route. Router-only
   delayed senders do not claim to verify worker lease/claim behavior.
5. Use a throwaway driver with a journal of intended/observed routing writes.
   Crash that driver after a router write and drop a response after applying it.
   Replaying an identical operation is idempotent; an authoritative read identifies
   the applied operation/generation/target. This tests router behavior, not new
   application DB pinning, transaction logic or worker code.
6. Through the driver, test higher-generation corrective barriers and replay
   conflicts, including withdrawing an unknown/unbound host. Verify no delayed
   lower-generation request can undo the confirmed barrier.
7. Withdraw an alias and verify fixed 404; restart the router and verify both the
   remaining bound alias and tombstone. Test unavailable durable storage: no
   request may fall through to some other Dokku app.
8. Check the upstream Host header and HTTPS/SNI validation using isolated
   certificates. Verify alias routing works behind an ordinary configurable
   proxy without depending on a Tailscale/Cloudflare account.
9. Load an older driver-journal snapshot while router state is newer, with a
   delayed pre-snapshot write still held by the old driver. After the restore
   procedure's new epoch and rotated credentials, that held write must fail even
   if its generation exceeds anything the router has seen. Demonstrate
   closed-ingress observed-state recovery. Simulate
   router-state loss and establish a new epoch that rejects every old credential/
   epoch combination.
10. Hold an old-epoch write inside the router after authentication and before its
    commit. Establish the new epoch and rotate credentials, then resume it. The
    router must reject it, the route must not change, and the authoritative read
    must show no state from that operation. Passing step 9 alone does not cover this
    case: a router that checks the epoch only at authentication would still commit it.
11. Remove only recorded experiment resources, report leftovers, and retain
    credential-free outcomes and exact image/build counts.

## Acceptance and evidence

All eleven steps must pass, with recorded versions/configuration, failure injection
points, route observations and cleanup results. One independent review must
validate the evidence and the chosen router's generation/persistence behavior.
Only then may schema, worker and public promotion integration start. The real
stale-worker-claim check in step 4 remains an integration acceptance gate, not a
guarantee verified by this router-only experiment.

The experiment needs no new application schema or HTTP API. Use the existing
Dokku deploy primitives and the throwaway driver; “stale worker” means a simulated
delayed sender. DB-side expected-generation CAS/409, the GC/reservation race,
superseded-operation pin chains and the retention clock are required in design
Slice 2 and the Slice 4 rehearsal **after** the router-only experiment passes.
They are not claimed verified by the experiment.

If no candidate can satisfy the contract, stop and propose a narrower guarantee
or a different router. Do not silently weaken stale-write, 404 or restore safety
to fit the available tooling.
