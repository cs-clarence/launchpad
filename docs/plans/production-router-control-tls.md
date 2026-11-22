# Production Compose: private router-control TLS

For maintainers continuing the production Compose functional blocker.
High-risk, medium implementation slice. The user approved operator-managed TLS
on 2026-11-22: operator-provisioned server certificate/key for Compose DNS `router`,
private CA trust scoped to control clients, explicit operator rotation, no CA service.

## Contract

- Add optional native TLS on the control listener only. Configure certificate,
  owner-only private key, CA file and server name together; fail closed on partial
  configuration. Existing literal-loopback plaintext fixtures remain compatible.
- HTTPS health checks use the configured DNS name and CA, with certificate
  verification enabled. The router's health checker is itself a control client.
- Add an optional CA file to the control client, passed only to its own fetch calls.
  Worker and every admin control-client construction use that setting. Do not
  weaken the existing HTTPS-or-literal-loopback application URL policy.
- Compose uses `https://router:3081`, mounts certificate/key only into the router,
  and mounts public CA into worker, admin and router health client only. Nothing
  publishes control port 3081. No CA private key is accepted by Compose.
- Operator provisions and renews certificates, then quiesces dispatch and recreates
  affected services. Keep routing state, epochs and tokens intact during certificate
  rotation; CA rotation first deploys an old/new trust bundle.

## Checks and undo

Unit-test configuration/refusal and CA-scoped request options. Add loopback TLS
integration coverage for trusted/untrusted/wrong-name certificates, plaintext
refusal and control/data separation. Run through Omni, then the full default
gate and Compose render checks. A real aliases-on Compose install remains a
separate disposable rehearsal; this change does not start production.

Before alias cutover, undo by reverting code/configuration together and keeping
aliases off. After cutover, stop dispatch, preserve router state and deployment
pins, and restore a verified TLS configuration; never fall back to bridge HTTP.
Independent security review and live Compose validation remain handback gates.

## Verification record (2026-11-22)

- `omni -i run check test build check:compose test:control:tls --force all`:
  100 enabled tasks passed; the database's disabled unit task was skipped.
- The focused TLS test uses a fixture CA and CA-signed server certificate. It
  verifies authenticated bind/promotion/withdrawal, trusted health, rejection of
  untrusted and wrong-name certificates, plaintext refusal and key permissions.
- Independent read-only security review found no blocking findings. It examined
  configuration, scoped CA trust, verification, key permissions, startup cleanup,
  health/DNS, Compose mounts and rotation/rollback docs. The reviewer did not
  independently rerun checks or interact with infrastructure.
- Full router integration was attempted without its PostgreSQL fixture: the
  managed-rotation test failed to connect; the other 15 tests passed. The
  separately run focused TLS task passed and requires no database.

An aliases-on disposable Compose run later passed (Docker DNS, mounts, bind,
promotion, reconciliation, withdrawal; see the P7 acceptance record). Still open:
restore and upgrade with aliases (certificate and CA rotation passed in that run). Production
has not been started.
