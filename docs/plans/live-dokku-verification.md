# Live Dokku verification

Approved on 2026-11-17: the agent may start the disposable Dokku with Docker.
Dashboard upload/deploy is also approved, to be implemented in the dashboard slice.

## Assessment and plan

Small operational verification, High risk because the suite deploys and destroys apps.
No product behavior changes; one operator, one bounded test run. Main unknown is whether
the disposable Dokku can deploy through this host's Docker socket. Changes are reversible
by stopping the named test container; test data stays separate from `.data/dokku`.
Escalate if verification requires changing the existing Dokku, demo, or host configuration.

1. Start `launchpad-live-dokku` from the existing Dokku image, with a fresh data directory
   under `/tmp/opencode`, loopback-only nonstandard ports and a new test-only SSH key.
   Verify SSH host identity against the container's own host key, not a network scan.
2. Run `omni -i run test:live -p @launchpad/worker`, using only the suite's guarded
   `lp-test-` names. Do not adopt or destroy existing apps; never touch `view-demo`.
3. Record the outcome, stop the named container, and confirm the suite removed its apps.
   On failure, report the residual test resources by name; never prune the Docker host.

This uses a disposable Dokku on the shared Docker engine rather than starting the existing
installation, avoiding its persistent state and demo configuration. Residual risk: the
Docker socket grants host control, so only the reviewed test fixture is deployed.

The first run exposed an exit-code mismatch: Dokku 0.38.34 returns 20, not 1, for a
missing app. Extend the existing exact-app-name check to accept 20 as well, with a
regression test that fails before the fix and negative coverage for unrelated failures.
This is a bounded compatibility fix within the live verification; no new Dokku verbs
or ownership patterns are added. Undo by reverting the fix; existence probes fail closed.

## Result (2026-11-17)

The live suite passed against disposable Dokku 0.38.34 after the fix, including static
serving, SPA routing, replacement/rollback and destroy-with-neighbour protection.
The suite left no apps in that Dokku. `launchpad-live-dokku` is stopped; its separate
test data and keys remain under `/tmp/opencode/live-dokku-20261117` for the later
authorized cleanup. The existing `view-demo.web.1` container was not changed.

Invocation used `omni -i -e .env.live-disposable-only run test:live -p @launchpad/worker`
with explicit test environment variables: selecting a nonexistent env filename prevents
the root `.env.local` from overriding the disposable SSH port. Host key pinning came
directly from the disposable container. Logs: `/tmp/opencode/live-dokku-20261117/results.log`.
The regression test failed before the fix; the full `check test build check:compose`
gate passed afterward. Database integration was not rerun for this transport-only fix.

## Second run (2026-11-17)

Run again against the same disposable Dokku 0.38.34 on `main` at `8288166`, after milestone 5's
last slice and before the milestone review: all five tests passed (static serving, SPA routing,
replacement and rollback, destroy-with-neighbour), the suite left no apps behind, and the container
was stopped. The destroy and Dokku code it exercises (`packages/dokku`, `apps/worker/src/lifecycle-ports.ts`,
`apps/worker/src/docker.ts`) has not changed since the first run. Still worth adding: a neighbour that
is deployed and probed over HTTP after the destroy.

## Restore runbook rehearsal (2026-11-18)

Approved test-only adapter (user chose it after the upgrade-drill review):
`apps/controller/src/admin/live/restore.live.ts` on the existing
`launchpad-live-dokku` (loopback SSH 33022, proxy 39080, isolated
`/tmp/opencode/live-dokku-20261117/data`) and `launchpad-test-db`
(loopback 55432). The test checked their identity before any mutation,
changed only its own disposable database's preview-name constraint to
`lp-test-<6>`, and injected that pattern into a test-only Dokku client and
deletion ports. Production schema/validation were unchanged.

The final opt-in `test:restore:live` run passed: created and deployed three
`lp-test-` apps; backed up the database and artifacts; initiated a deletion
after the backup and simulated stopping the worker with an outstanding
remote destroy; waited for the remote command to complete and for its
shortened one-second **test** lease to pass; restored into a fresh database
and data directory; `checkRestore` using the real guarded Dokku client
found the missing app and an expired preview; redeployed a kept preview
from its restored archive; extended the expired preview while lifecycle
was off; enabled lifecycle and finished deletion of the preview chosen to
end. The kept and extended apps remained until the test's exact-name
cleanup. An `apps:list` after completion reported no apps. Two earlier
runs failed while debugging redeployment with the old deployment id;
the final run uses a fresh id, as a real redeployment does.

The test models a stopped worker's lost response and delayed remote
completion, not an OS process killed in the middle of an SSH command;
the one-second test lease is **not** the five-minute production lease.
An operator must still wait for the full lease and slow Dokku triggers
in a real restore. No `view-demo` or other Dokku was touched.
