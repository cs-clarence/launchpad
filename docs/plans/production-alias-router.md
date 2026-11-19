# Production alias router implementation

## Goal, authorization and assessment

Continue the approved immutable-deployment preparation on draft PR #53. The user
said “Go continue” after the remaining work and the production-router next step
were described. Production startup, publishing, DNS/connector changes and broad
cleanup remain unauthorized.

This is the routing portion of the existing **Large / High-risk** change:
`docs/design/deployment-modes.md`. The disposable Bun/SQLite feasibility run and
independent Opus evidence review passed; see `routing-experiment-evidence.md`.
The prototype is evidence, not code to ship.

## Approach and boundaries

Use a single authoritative Bun process with SQLite WAL and `synchronous=FULL`.
The experiment demonstrated the necessary generation, persistence and epoch
behavior. A stock proxy alone does not supply this control contract; PostgreSQL
would add a runtime dependency without removing the need for a routing authority.
Keep the routing authority's durable state separate from the controller database.

Build a small private `@launchpad-kit/alias-router` core first, with no listener or
automatic startup. Then add the `apps/router` control/data-plane host, client,
operator commands, image and integration checks. The core is independently
testable through its authenticated operations; it is not a production-readiness
claim on its own. No schema migration or existing worker/controller behavior
changes in this first increment.

### Core contract (R1)

- Explicit initializer creates a **new** state file, schema version and initial
  instance/epoch/credential hash. Opening existing state never creates or repairs it.
  Require a private, owned, physical state directory and regular mode-0600 file.
  Create exclusively (`wx`), then initialize schema and complete metadata in one
  transaction. Interrupted/incomplete metadata is unsupported, never completed
  during open. The operator supplies the initial random token; the core never
  generates, returns or logs a plaintext secret.
- Secrets are random 32-byte lowercase hex tokens. Hash before storing or retaining
  an authenticated handle; compare fixed-size digests in constant time. Errors and
  returned state never contain credentials or hashes.
- `authenticate({instanceId, epoch, token})` returns an opaque, store-owned writer
  capability. Every mutation revalidates its authority inside a synchronous
  `BEGIN IMMEDIATE` transaction. No await, hooks or externally supplied callback
  exists between that check and commit. Forged or foreign-store handles fail closed.
- A local-only `rotateAuthority({epoch, token})` transaction changes both together,
  retaining all routes and generations. Persist used epochs and token hashes to
  refuse their reuse. The future HTTP adapter must **not** expose this operation:
  it belongs to the operator process with direct state-file access.
  Instance identity never changes. Epochs are opaque lowercase UUIDs, not ordered
  counters: fresh/non-reused is required, not UUID lexical ordering. Rotation
  invalidates every prior handle across open store objects; a handle belongs to
  its exact open object and is invalid after close/reopen.
- Authenticated `registerDeployment({deploymentId, hostname})` admits a generated
  one-label hostname under the configured apps domain. It records immutable target
  identity, not a caller URL, address or proxy directive. An identical registration
  is idempotent; reassignment conflicts.
- Authenticated `replaceRoute({aliasId, hostname, operationId, generation,
  targetDeploymentId})` binds a registered target or writes a null tombstone.
  The first authenticated bind/withdraw reserves the hostname and alias identity;
  generation 0 remains backend-only. Alias and deployment ownership share one
  reservation registry, including all tombstones.
  New aliases use the same canonical ASCII lowercase/no-trailing-dot, one-label
  admission rules as deployments. An alias ID with a different hostname, or a
  hostname owned by any other identity (including tombstones), conflicts.
- Generations are canonical positive decimal strings, capped at PostgreSQL bigint
  maximum `9223372036854775807`. Compare with `BigInt`, never JavaScript numbers.
  Higher generations apply, exact latest-operation replay is idempotent; lower or
  conflicting equal generations return conflict without changing state.
  Retain committed operation identities/payloads to reject operation-ID reuse with
  different contents. Any non-latest replay conflicts; R2 must read authoritative
  state to classify it as superseded rather than assuming it never applied.
  Reaching maximum generation permanently exhausts that alias's writable counter.
- Existing registered hostnames survive configuration changes; only new admission
  uses the current apps domain. No hostname/identity reuse or target removal in R1.
  Apps domain is passed when opening state, not persisted as an admission policy.
  The backend later enforces same-app membership, deployment eligibility and pins;
  this core trusts its authenticated worker for those application facts.
- Authoritative reads return current epoch plus exact route identity, operation,
  generation and immutable target hostname. Unknown routes return no mapping;
  tombstones remain distinguishable to the control plane. Neither selects upstream.
- Check state path identity, ownership and permissions on operations. Missing,
  replaced or inaccessible database/durable state must report unavailable rather
  than serving a cached mapping. Close on corrupt/unsupported state; never fall back.
  Snapshot directory/database/sidecar dev/ino, owner and permissions with `lstat`,
  refusing symlinks. Require directory 0700, database and owned WAL/SHM files 0600;
  normalize fresh sidecar permissions inside the private directory. Check identities
  during reads and inside mutation transactions immediately before commit.
  Set bounded `busy_timeout`, `trusted_schema=OFF`, schema version checks and an
  integrity check on open. Do not expose or enable extension loading.
- Library import performs no I/O. Initialization/opening are explicit. One process
  owns routing; immediate transactions additionally serialize local operator writes.

### Worked acceptance example

Initialize instance I / epoch E1 / token K1. Register immutable deployments A/B;
bind alias X generation 1 to A and alias Y generation 1 to A. Move X at generation
2 to B, then 3 back to A; Y never changes. Authenticate a writer and pause its
caller. Commit a higher-generation barrier, then submit its old generation:
conflict. Authenticate another writer, rotate to E2/K2 with the local operator
API, then submit its unseen higher generation: unauthorized at commit.

Close and reopen state; both mappings, ownership and epoch survive. Withdraw X;
reopen again; its tombstone/generation still fence old binds. Missing state,
permissions removed, a replaced database path, unsupported version, malformed
payloads, invalid handles and conflicting identities all fail closed. A maximum
generation is accepted; overflow and noncanonical strings are rejected.

## Delivery, checks and undo

| Increment                   | Outcome and verification                                                                                                                                                                                                                                             | Undo / gate                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| R1: core                    | Generator-created private package, strict input schemas, durable authority/registry/route operations, filesystem + SQLite fixture tests without listeners. Opus review of design before building and implementation before push; Omni `check test build`             | Additive/unwired; remove package without changing existing runtime or application DB                                        |
| R2: host/client             | Separate private control and public data listeners; bounded authenticated API, fixed-404 routing, trusted Host/SNI, streaming/header/time/resource limits, validated settings, explicit init/rotate commands with secret files; client classifies uncertain outcomes | No fault hooks, generic proxy endpoints or HTTP epoch rotation; review and isolated integration tests before runtime wiring |
| R3: packaging/rehearsal     | App-local Dockerfile, unprivileged state ownership, image checks and a repeat of the accepted router scenarios against the production implementation                                                                                                                 | Disposable services only; exact resource inventory/cleanup; production untouched                                            |
| R4: application integration | Original immutable-model slices 2–4: migration/retirement, worker/promotion/retention, all clients, Compose and restore rehearsal                                                                                                                                    | Stale-worker-claim, pins/GC and restore counter reconciliation remain mandatory gates; no mixed-version workers             |

R2 must enforce a single service owner (an exclusive process lock or equivalent).
R1's immediate transactions serialize local operator writes but do not themselves
enforce one process. An older restored copy of router state can resurrect an old
epoch/credential; R4 must establish a fresh epoch/credential and fence ingress
before opening mutations, not rely on R1 to detect an offline rollback.

## R2 design: host (split in two increments)

The host must not move the commit-time guarantees out of R1: it adds transport only. It is
delivered as **R2a** (listener-free handlers and settings in `@launchpad-kit/alias-router`, tested
with injected requests) and **R2b** (`apps/router`: operator commands, listeners, process lock).

### R2a: handlers and settings

- Both handlers are `(Request) => Promise<Response>` closed over one open `RouterStore`; neither
  opens a file, binds a port or reads the environment. Settings come from a pure
  `parseRouterHostConfig(env)`: state file, instance ID, apps domain, control and data listen
  addresses (`host:port`, no default exposure), upstream proxy URL (http/https, no credentials,
  query or fragment) and an optional upstream CA file path. No secret is ever a setting value.
- **Control handler (private listener).** `GET /healthz` (no authentication, no data, 200 only when
  the store answers a bounded read, else 503). Everything under `/v1` requires
  `Authorization: Bearer <64 hex>`, `X-Launchpad-Instance` and `X-Launchpad-Epoch`; each request
  calls `store.authenticate` and the mutation rechecks at commit (R1). Endpoints: `POST
  /v1/deployments`, `POST /v1/routes`, `GET /v1/routes/{hostname}`, `GET /v1/routes?after&limit`.
  Reads are authenticated too: the inventory is not public. **No rotation, initialization, hold,
  release, drop-response or generic proxy endpoint exists.** Bodies: `application/json` only, at
  most 8 KiB, bounded while streaming, strict parse and the R1 strict schemas. Status mapping:
  invalid 400, unauthorized 401, conflict 409, unavailable 503, unknown path 404, wrong method 405.
  Responses are `application/json` with `Cache-Control: no-store` and fixed error bodies that never
  echo input, paths, SQLite text or credentials.
- **Data handler (public listener).** Only `GET`, `HEAD` and `OPTIONS` (others 405), so no request
  body is ever forwarded. The `Host` header is lowercased and its port removed, must be a canonical
  hostname, and is looked up with `store.readRoute`. Unknown, unbound, withdrawn or malformed hosts
  return the same fixed `404` text with no upstream call, and an unavailable store returns a fixed
  `503`: neither falls back to Dokku or another app. A bound host is forwarded to the configured
  upstream proxy with `Host` set to the **target deployment's immutable hostname**; for an https
  upstream, SNI and certificate verification use that same hostname (optional private CA), and
  verification is never disabled. Hop-by-hop and forwarding headers from the client are dropped and
  upstream redirects are returned, not followed. Connect and header timeouts are bounded; an
  unreachable or slow upstream is a fixed `502`/`504`.
- The upstream call is injectable so unit tests need no listener; a loopback integration suite
  (`test:integration`) exercises the real Node HTTP/HTTPS transport, including Host/SNI with
  OpenSSL-generated test certificates, a wrong-name certificate (must fail), redirects, HEAD and
  timeouts.

### R2b: app, process lock and operator commands

`apps/router` binds the two listeners from the settings and owns the **single-process lock**, held by
the kernel rather than inferred from a PID: a dedicated SQLite lock file next to the state, opened
with `locking_mode=EXCLUSIVE` and an open `BEGIN EXCLUSIVE` for the life of the process. A second
process fails immediately and a crash releases it. No PID is written, and a lock file with any
content is **refused** (fail closed) rather than ignored or interpreted: the file is empty by
construction, so content means tampering. Operator commands `init` and `rotate` read the token from an
owner-only file (others refused) or standard input without echo, never an argument or the
environment, call the R1 functions directly and print only the epoch. `rotate` takes the same lock
and so refuses to run while `serve` is running. `serve` refuses to start without complete state.
Shutdown order: stop accepting, drain with a deadline, abort in-flight upstream calls, close the
store, release the lock. The listeners set a header-size limit, header-read and keep-alive idle
timeouts and a connection cap (values recorded in the app). A health check, image and Compose
wiring are R3.

### R2 amendments from the design review (binding)

- **Host canonicalization (data plane).** HTTP/1.1 only: no h2 and no `:authority`. The host comes
  from the single raw `Host` header and must match the host of the request URL. The fixed 404 is
  returned for a missing or duplicate Host (a comma or whitespace), an IPv6 or bracketed host,
  userinfo (`@`), percent-encoding or non-ASCII, a non-numeric or out-of-range port, a trailing
  dot, or a host that is not a canonical lowercase hostname. The host is lowercased and the port
  stripped before `readRoute`. **Decision:** the apps domain is _not_ re-checked on the data plane.
  The registry is the authority for which hosts serve, and R1 guarantees every registered hostname
  was admitted under the apps domain when registered and keeps serving after a domain change; a
  second filter would silently drop existing routes. The management origin can never be registered
  because admission requires a label under the apps domain.
- **Request target.** Only origin-form paths starting with `/` are forwarded, onto the fixed
  upstream origin (the upstream URL path must be empty). Absolute-form, `*` and CONNECT are handled by
  the HTTP server and cannot reach the handler as such; the handler also refuses a non-`/` path. A
  request with `Transfer-Encoding` or a non-zero `Content-Length` gets 400, as no body is forwarded.
- **Request headers dropped:** `Connection` and every header it names, `Keep-Alive`, `TE`,
  `Trailer`, `Transfer-Encoding`, `Upgrade`, `Proxy-*`, `Forwarded`, `X-Forwarded-*`, `X-Real-IP`,
  `Via`, `Content-Length`, `Authorization`, and every `X-Launchpad-*`; `Host` is replaced. `Cookie`
  passes through. **The router sets no forwarding headers**, because the immutable static sites do
  not use them and the trust boundary in front of the data listener is the operator's. **Response:**
  hop-by-hop headers (and those `Connection` names) are stripped; `Location` and `Set-Cookie` pass
  through unchanged. _Record for R4:_ an upstream `Location` or cookie `Domain` that names the
  immutable hostname leaks it and moves the user off the alias.
- **Timeouts.** Connect plus response headers 10 s (`504` on timeout; `502` for connect, TLS,
  verification or protocol failure); response-body idle 30 s and a 5 minute total deadline; the
  upstream call is aborted when the client disconnects; after headers are sent a failure aborts the
  stream (the status can no longer change).
- **Control plane.** Authentication runs before route matching for everything under `/v1`, so
  unknown paths and wrong methods reveal nothing without credentials; every authentication failure
  (missing header, wrong instance, stale epoch, bad token) is the same fixed `401`. The path
  `{hostname}`, `after` and `limit` use the R1 canonical rules. `Content-Type` must be
  `application/json`, optionally `; charset=utf-8`. `/healthz` exists only on the control handler,
  unauthenticated, and its `503` body is fixed text.
- **Settings.** The control address must be loopback unless an explicit
  `LAUNCHPAD_ROUTER_CONTROL_PRIVATE_NETWORK=1` is set (the bearer token travels over plain HTTP, so
  a non-loopback bind is an operator decision on a private network); control and data addresses
  must differ and must not overlap through a wildcard on the same port.
- _Record for R3/R4:_ the private CA is read at startup (rotating it needs a restart); the
  forwarding-header policy above; no HTTP/2.

### R2 acceptance and undo

R2a: strict-schema/status-mapping tests for every endpoint; authentication failures reveal nothing;
oversized, non-JSON and malformed bodies rejected before parsing; each data-plane 404/503/502 case;
mutation checks for the Host rewrite, the fixed 404 and the 405 rules. R2b: lock tests (live, stale,
corrupt), CLI tests with secrets never on argv, and a restart/shutdown test. Undo: remove the
additive package code or the unreferenced app; nothing else depends on them until R4.

## Open questions and exclusions

- Production ingress domains, storage provisioning and deployment networking remain
  operator choices. They do not block a private, unwired R1 core.
- R2 must enforce management/apps registrable-domain separation and keep control
  transport private (or explicitly authenticated TLS); R1 has no network surface.
- SQLite behavior under physical power loss depends on storage honoring fsync.
  Tests prove process/reopen and transaction behavior, not hardware guarantees.
- No replicas, external custom domains, ACME/DNS integration, metrics backend or
  automatic repair. No feature flag silently adopts the experimental service.

## Progress

- Opus design review accepted R1 after six clarifications above (admission,
  replay classification, authority/handle lifecycle, sidecars/identity checks,
  exclusive atomic initialization, and configuration policy).
- R1 implemented in `packages/alias-router` (39 tests on real SQLite files). Mutation checks confirmed
  that removing the commit-time authority check, or the file-identity check, fails tests. Opus implementation review: no blockers. Fixed
  its findings: lock contention is retryable instead of latching the store closed, credential hashes
  are constrained to lowercase hex, stale rollback journals are refused, and a failed initialization
  removes only what it created (5 tests added; 44 total). Left as optional: opening sidecars with
  `O_NOFOLLOW` before `fchmod` (the directory is owner-only 0700 and re-checked). Nothing is wired
  into the controller or worker.
- R2 design reviewed by Opus: ready to build R2a once the amendments above were recorded (done). R2b needs the kernel-held lock design above.
- R2a implemented: `src/host/` (control and data handlers, header policy, settings, Node HTTP/HTTPS
  upstream) with 41 unit tests (80 in the package) and 9 loopback integration tests. Mutation checks
  caught: a client-chosen or unrewritten Host, a non-404 for unbound hosts, extra methods, forwarding
  headers, authentication after routing, the body bound, disabled TLS verification and a wrong SNI. A
  first TLS test passed vacuously because a shared cleanup closed its server; fixed, and a control
  request now proves the server is reachable before each failure case. Opus implementation review: no blockers; its
  hardening findings are fixed (abort listener and timer released on every failure path, a body that
  fails mid-read is 400, IPv6 listen hosts are bare, one Connection-header helper, canonical ports, no
  unreachable 101 case). Status 413 was added for oversized bodies.
- R2b implemented in `apps/router`: `serve`, `init` and `rotate`, secrets from an owner-only file or
  stdin, the kernel-held lock, ordered shutdown, 15 unit and 10 integration tests (real listeners, raw
  sockets with hostile request lines, a CLI subprocess with SIGTERM). Mutation checks caught: a
  non-exclusive lock, abandoning the drain, rotate without the lock, the secret mode check and a leaked
  store connection (observable as surviving WAL sidecars). Findings recorded rather than hidden:
  `Bun.serve` offers no header-size limit, header-read timeout or connection cap, and it routes
  absolute-form requests by `Host` (cannot redirect traffic; documented). Opus implementation review found a real
  defect and fixed it: closing _any_ Node descriptor on the lock file drops all of the process's POSIX
  locks, so a refused second attempt in the same process silently released the first attempt's real lock.
  Node now only creates the file (exclusively) and checks it by path; SQLite alone opens it, and the
  path identity is re-checked once the lock is held. Added a two-process regression test (fails against
  the old code), a SIGKILL test (the kernel releases the lock, no stale lock), strict `serve` arguments
  and the NFS caveat.
- R3a implemented: `apps/router/Dockerfile` (uid 10001, `/state` volume at 0700, no EXPOSE, a
  `healthcheck` command that asks the control listener's `/healthz`), checked by `test:images` end to end
  (init from stdin, refusal to reinitialize, healthy, 401/404 planes, second router refused by the lock,
  graceful stop, rotate after stop; no leftovers) and built by the release dry run. R3b is done: the accepted experiment
  scenarios pass against this image on a disposable Dokku (see `routing-experiment-evidence.md`, "Production
  router rehearsal"); a mutant router with its epoch check removed fails the run in its first phase. Opus reviewed the
  evidence: accepted once an unsupported `init` claim, an unbounded refuse-to-start check, a hostile-request
  pass on a closed connection and some overclaims were fixed; the rehearsal was rerun on the final code. R4 (the immutable model) is next.
