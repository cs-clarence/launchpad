# Worker

The privileged half of deployments, currently **idle**. The preview deployment runtime (the polling
loop, the lifecycle, expiry and deletion) was removed; the process only keeps a health marker and logs
`legacy-runtime-removed`. It opens no database and needs no Dokku settings. The Docker and Dokku
modules (`build.ts`, `ports.ts`, `verify.ts`, `lifecycle-ports.ts`, `template.ts`) are kept for the app
worker that returns with the immutable model, and are covered by unit tests. Keep this page current
when that changes.

## Live tests

`omni -i run test:live -p @launchpad-kit/worker` runs the worker's real steps against a real
Dokku and Docker: the fixture site, a real 404, SPA deep links, replacing a release and
rolling back, and destroying one app with the worker's real destroy port while a neighbour
app is left alone (the ports are called directly; `runDeletion` itself is tested against fakes).
It is opt-in, never part of `test` or CI, and needs a **disposable** Dokku (a throwaway
container; how it was set up and run is in
[the live verification record](../../docs/plans/live-dokku-verification.md)). It only creates apps named `lp-test-<6 characters>`, records them,
and destroys only those at the end; it never touches any other app. Without its settings
it fails at once with a message. The settings are listed at the top of
`src/__tests__/live.spec.ts`.

## Running it (when the app worker returns)

- A load or rollback in progress is not interrupted by a shutdown (a half-loaded image is
  worse than a slow stop). A load can take up to about 11 minutes and a rollback up to
  1.6 times the lease (24 minutes with the default), so give the process a stop timeout
  of at least 1.6 times the lease plus a margin (25 minutes by default); a SIGKILL
  mid-load or mid-rollback leaves the deployment held for reconciliation.
- Startup removes scratch build directories older than an hour that a killed worker left
  behind. Images are removed after each load; an image built but never loaded (a failure
  before the load) stays in the local engine until removed by hand: there is no global
  prune, on purpose.
- Failure details (a failed build's output, say) are kept on the error for operators but
  are not logged yet; the log lines carry only outcomes.
