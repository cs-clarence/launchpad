# @launchpad-kit/router

The alias router: the private **control plane**, the public **data plane** and the operator commands.
For operators and contributors. **Private and not yet wired in:** nothing in the controller or worker
uses it, and it has no image or Compose service yet (R3 of
[the plan](../../docs/plans/production-alias-router.md)). The routing rules live in
[`@launchpad-kit/alias-router`](../../packages/alias-router/README.md); this app only binds them to
sockets, owns the process lock and reads secrets safely.

## Commands

```sh
launchpad-router serve                                     # run both listeners
launchpad-router init   (--token-file <path> | --token-stdin)   # create new state, print its epoch
launchpad-router rotate (--token-file <path> | --token-stdin) (--database-url-file <path> | --standalone)
```

Stop the router before rotation. For a router used by Launchpad, pass `--database-url-file` (an owner-only 0600 file
holding the primary promotion database URL; a role with only CONNECT is enough, since
the command takes an advisory lock and checks the catalog). Managed rotation refuses
an unmigrated or replica database, then takes the exclusive deployment recovery lock; a worker holds the shared lock from fresh
router verification through commit. Update the worker epoch and token files before
resuming work. `--standalone` is only for isolated routers with no Launchpad model
users and must never be used on managed state.

If the worker parks an operation (`route-outcome-unknown` or `alias-generation-mismatch`), use
`launchpad-admin promotion-reconcile --operation <id> --target <deployment-id>
--i-have-verified-the-router-by-exact-route` (or `--withdraw` for an uncertain
withdrawal; `promotion-repair-generation` is the same command). Point the admin at the authoritative router and model database.
The command reads and checks that exact alias, then queues a correction above
the database and router counters. It neither changes the route nor releases
pins; a worker must verify the correction. If the alias or router reports an
unrecognized target, stop and investigate rather than editing counters by hand.
The admin command sends the control token only over HTTPS, or HTTP on loopback; put a TLS
endpoint in front of a private router control address.

`init` and `rotate` read the **same settings as `serve`**, including the listen and upstream
variables (they are validated but unused there), so one environment serves all three commands.
Settings are `LAUNCHPAD_ROUTER_STATE_FILE`, `LAUNCHPAD_ROUTER_INSTANCE_ID`, `LAUNCHPAD_APPS_DOMAIN`,
`LAUNCHPAD_ROUTER_CONTROL_LISTEN`, `LAUNCHPAD_ROUTER_DATA_LISTEN`, `LAUNCHPAD_APPS_PROXY_URL` and
optionally `LAUNCHPAD_ROUTER_UPSTREAM_CA_FILE` and `LAUNCHPAD_ROUTER_CONTROL_PRIVATE_NETWORK=1`
(validated by `parseRouterHostConfig`). The control address must be loopback unless that last flag
confirms a private network, because the bearer token travels over plain HTTP.

- **The token** (64 lowercase hex characters, supplied by you) is read from an owner-only (`0600`)
  file or from a pipe on standard input. It is never an argument or an environment variable, and no
  message or output contains it. `init` and `rotate` print only the new **epoch**, which the worker
  needs and which is not a secret.
- **The state directory** must already exist, be owned by the running user and have mode `0700`;
  nothing creates or repairs it.
- **One process owns the state.** A kernel-held lock (`<state file>.lock`, an empty private SQLite file
  held exclusively) is taken by `serve`, `init` and `rotate`, so a second router or a `rotate` while
  the router runs fails immediately, and a crash (even `SIGKILL`) releases it. A lock file with any
  content is refused, never interpreted. The lock is a kernel file lock, so it excludes processes on
  one host (including bind mounts and overlay filesystems) but is **not reliable on NFS or other
  network filesystems**, and two hosts sharing one volume will not exclude each other: run exactly
  one router per state directory.
- **Shutdown** (`SIGTERM`/`SIGINT`): stop accepting, drain in-flight requests for up to 10 seconds,
  abort what remains, close the store, release the lock.

## Limits (recorded for R3 and R4)

- `Bun.serve` exposes only an idle timeout and a body-size limit, so the header-size limit, the
  header-read timeout and a connection cap are Bun's defaults. Put a firewall or reverse proxy in
  front of the data listener if you need more.
- Bun routes an absolute-form request line by its `Host` header and ignores the target's authority
  (RFC 9112 says the authority wins). It cannot redirect traffic: the upstream comes only from the
  registry. A front proxy that routes on the request target should normalise it.
- HTTP/1.1 only; no access log yet; the router adds no forwarding headers.
- Control-plane transport is plain HTTP on a private address.

## Tasks

`omni -i run check test build -p @launchpad-kit/router`. `test:integration` starts real loopback
listeners and runs the CLI as a subprocess: no Docker, no database and no `openssl`.
