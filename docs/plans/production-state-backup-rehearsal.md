# Disposable Dokku and router-state backup rehearsal

For maintainers completing the [production Compose follow-up](production-compose-follow-up.md).
Medium implementation and high operational risk: both state copies can contain
credentials, and two active Dokku or router authorities are unsafe. The existing
matched PostgreSQL/archive backup does **not** include either state directory.

## Scope

Verify a **same-host** recovery of state using a unique aliases-on Compose
project and fresh destinations. Keep the same Docker engine, its deployment
images and containers, the fixture database, and the apps network. This is not
a host-loss recovery test; it does not prove image recovery, external plugin
state, arbitrary app volumes, or portability to a new Docker engine.

## Sequence and checks

1. Deploy two immutable sites, bind and promote one alias. Record Dokku's
   exact app inventory and host-key fingerprint, and the router's current
   epoch and route generation. Stop controller and worker; confirm writers
   exited and the fixture Dokku host has settled.
2. Stop the fixture router and Dokku. Archive their state offline into
   separate private files, preserving numeric ownership and modes. Verify
   the archives and record digests without publishing their contents.
3. Extract into a fresh Dokku bind and a fresh router volume. Recreate only
   the fixture router and Dokku using those destinations. Do not run router
   `init` or `rotate`; do not start a second authority on the source state.
   Require healthy services, the same Dokku host key and app names, and the
   same authenticated router epoch, route generation and served identities.
4. Restart fixture writers, promote the alias again and verify the generation
   advanced; then withdraw, delete and prove exact-scope cleanup. Keep the
   original state until restored service and writes are verified. These
   checks do not authorize substituting older router state beneath a live
   database: real recovery must handle the [generation and epoch gates](../restore.md).

If an assertion fails, stop only already-identified fixture writers, do not
resume mutations, and preserve the source and destination state if settlement
or ownership cannot be verified. Keep archives private and remove only the
recorded fixture files after verification. Never apply this rehearsal to an
installed state directory.

## Result (2026-11-23)

The first attempt verified both archives and restarted from the new state
locations. Its first data-plane request disconnected even though the services
reported healthy. Exact-scope cleanup passed. The retry used a bounded wait
for application-level readiness; it did not need to rebuild Dokku's proxy config.

The retry verified archive checksums and restored a fresh Dokku bind and router
volume while keeping the originals offline. It checked the actual replacement
mounts, the original Dokku SSH host key and both app names, and identical
authenticated router route data. The two deployment URLs and the alias still
returned the expected served identities. After restarting the writers, the
restored router committed a higher generation without initialization or
rotation, withdrew the alias to a 404 tombstone, and both deployments were
deleted. Exact-scope cleanup verified the containers, networks, volumes,
images, archives and fixture secrets were gone.

Evidence: `/tmp/opencode/lp-compose-state-7XLwn6ti/`. This was a one-off
fixture, not a new mode of the reusable baseline task. The result is for the
same engine with its existing app containers, image tags and apps network;
it does not establish host-loss recovery. A healthy Docker service alone
is not a readiness gate for serving restored app traffic.
