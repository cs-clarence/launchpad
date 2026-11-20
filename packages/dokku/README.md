# @launchpad-kit/dokku

Typed, allowlisted Dokku operations over SSH with a pinned host key. For
contributors extending what the controller's worker may ask Dokku to do. Keep this
page current when operations or trust rules change.

```ts
import { createDokkuClient } from "@launchpad-kit/dokku";

const dokku = createDokkuClient({
    host: "dokku",
    port: 22,
    username: "dokku",
    privateKeyPath: "/run/secrets/dokku_key", // mode 600, plain absolute path
    knownHostsPath: "/run/secrets/dokku_known_hosts", // pinned out of band
});
await dokku.apps.create("lp-abcde12345");
```

## What it can do

`apps.create | exists | destroy | list`, `domains.set | report`, `ports.set`, `git.loadImage` (streams a
`docker save` archive to `git:load-image`) and `ps.report`. **There is deliberately no
generic command runner**: a new operation is a new validated function in `client.ts`,
and the package exports none (a test pins the exported surface). The real `SshTransport` is not exported either: with it a caller could send commands the client would never build. Only the `Transport` types are, so a fake can be injected.

The drift reader uses two read-only operations: `apps.list()` sends the fixed
`apps:list --format json` (including unrelated names), and `domains.report(app)`
sends `domains:report <exact-name> --domains-app-vhosts`. Their output shapes follow
Dokku 0.38.34; malformed or truncated replies fail, never become an empty inventory.
Both use the quick timeout and output bound. Listing does not authorize mutations
or domain reads outside the client's configured app-name pattern.

## Why it is safe to call

- **Arguments are validated, never escaped.** App names must be exactly `lp-` plus ten
  lowercase letters or digits (a wider pattern is opt-in, for live tests); hostnames,
  image tags and port mappings each have their own narrow pattern. The finished command
  is checked again (words and fixed long flags only), and ssh is started without a
  shell, with `--` before the destination so nothing can be read as an ssh option.
  Display names never reach this package.
- **Trust is checked before every command, and failing it sends nothing.** The
  known_hosts file must pin this host and port with an explicit entry: wildcards,
  negation, hashed names, `@cert-authority`/`@revoked` markers, unsupported or corrupt
  keys are all refused, and a file that is missing, linked or oversized is refused. The
  private key is checked, not read: it must be a regular file, private to its owner,
  and not a link. These files are re-checked on every call. The client never scans for
  or learns a host key.
- **The connection fails closed.** `StrictHostKeyChecking=yes`, `BatchMode=yes`,
  `IdentitiesOnly=yes`, passwords and keyboard-interactive off, no agent, no
  forwarding, `-F /dev/null` (the user's ssh config is ignored), and a minimal
  environment (no `SSH_AUTH_SOCK`, no proxy variables).
- **Output is bounded and timed.** Output beyond the limit is dropped, not buffered;
  every call has a timeout (15 s reads, 60 s changes, 10 min image loads) and accepts an
  `AbortSignal`; a command that outlives either is killed (SIGTERM, then SIGKILL).

## Errors: five kinds, and what to do with each

| `kind`             | Meaning                                                                                                | Response                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `invalid-argument` | Refused locally; nothing was sent                                                                      | Fix the caller                                                                               |
| `trust`            | Host key or credentials not trusted; nothing was sent                                                  | Operator must fix the files                                                                  |
| `not-started`      | Connection failed before a session existed (host key rejected, auth, refused, DNS, timeout connecting) | Safe to retry                                                                                |
| `failed`           | The remote command ran and reported failure                                                            | Handle as a normal failure                                                                   |
| `uncertain`        | Timeout, cancellation or a dropped connection: it may or may not have run                              | **Reconcile, never blindly retry** (`needsReconciliation(error)` is true for a mutating one) |

`not-started` needs positive evidence: remote output shares ssh's stderr, so a substring match proves nothing. Anything else on a lost connection, including any output received or any input sent, is `uncertain`.

`error.message` is fixed text. Remote output is in `error.detail` (printable, bounded)
for operator logs only; do not return it to API clients.

## Testing

Unit tests need no Dokku or network. The real transport is exercised with stand-in
`ssh` executables that record their arguments and environment, hang, flood output, read
or ignore standard input; the client with a fake transport. The live-engine tests are the worker's opt-in suite
(`omni -i run test:live -p @launchpad-kit/worker`, see `apps/worker/README.md`); it touches only a
disposable Dokku the developer started.
