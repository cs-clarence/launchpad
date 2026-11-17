# Post-milestone production Compose follow-up

Requested by the user after all application milestones are complete (2026-11-15).
This extends the execution queue beyond milestone 2; do not start production
packaging in place of unfinished application milestones.

## Requested outcome

- Clean up development/test resources created by the agent after milestone work.
  The user explicitly authorized both taking down their existing Dokku/demo
  setup and deleting its persistent data during the final cleanup. Identify the
  associated containers, volumes, `.data/dokku` and `view-demo` data before
  deletion. Do not broadly prune Docker or touch unrelated resources/data.
- Prepare a production Compose stack with controller, worker, PostgreSQL, Dokku
  and other required dependencies wired together and operationally documented.
- Move the Dokku Dockerfile to `containers/dokku/` and put other custom Dockerfiles
  for external services under `containers/<service>/`. Update build contexts,
  paths, tooling checks and documentation together.
- Avoid commonly used **host** ports, including 8080 and 443. Distinguish internal
  service ports from host bindings, and settle public TLS/ingress routing before
  claiming the deployment is production-ready.
- Update the relevant `.env.local.example` files and customize the gitignored
  `.env.local` for easy startup. Preserve existing local values, obtain secrets
  through the secret workflow when needed, and never commit local credentials.

## Gate

Reassess and write the concrete High-risk deployment plan when the application
milestones are done. Verify images, privilege boundaries, health/readiness,
durable storage, migrations, secret handling, resource limits, upgrades,
backup/restore and rollback. A syntactically valid Compose file alone is not a
production-readiness claim.

The request authorizes preparing configuration and cleanup of agent-created
resources; it does not require starting the eventual production stack or
publishing images/namespaces.

## Status

Queued. Application milestones 0 to 5 are built; milestone 6 (backup, restore, release) remains.
Requirements this work must meet that the application milestones surfaced:

- The controller and the worker share one data directory and must run as **one user** with read
  and write access; the worker also needs the Docker engine it builds on and SSH to Dokku.
- The worker's stop timeout must outlast a load or rollback (about 24 minutes at the default
  lease); a stop that kills it earlier leaves that deployment held for an administrator (`load-uncertain`).
- Both processes need `LAUNCHPAD_LIFECYCLE` and `LAUNCHPAD_DEPLOYMENTS` to agree; ship a worker
  environment example (`apps/worker/.env.local.example` exists) and document the agreement.
- The worker validates uploaded archives with the same limits as the controller
  (`LAUNCHPAD_MAX_EXPANDED_BYTES`, `LAUNCHPAD_MAX_ARCHIVE_ENTRIES`, `LAUNCHPAD_MAX_ARCHIVE_DEPTH`):
  give both processes the same values, or valid uploads fail at extraction.
- Run the migrations as an explicit step before either process starts, one database per Dokku host
  and per data directory.
- Decide where images for previews live when Dokku is a separate engine (the worker does not remove
  images it loaded onto another host).
