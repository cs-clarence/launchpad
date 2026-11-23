# Rehearse Launchpad ingress with Caddy

For operators and maintainers verifying ingress before connecting real clients.
Caddy is a reference proxy, **not a Launchpad dependency**. This example runs
in a disposable Linux VM, binds only loopback, and needs no real DNS, tunnel,
VPN or external certificate service. It is not a production configuration.

## Prepare the fixture

Use a disposable aliases-on [Compose fixture](plans/production-compose-rehearsal.md)
with two live deployments and an alias pointing to the second deployment.
Keep the controller, Dokku previews, and router data ports bound to loopback.
Keep `LAUNCHPAD_TRUSTED_PROXY=false`. Set the controller's
`LAUNCHPAD_BASE_URL` to the exact fixture management origin
`https://control.example.net:8443` and its apps domain to `sites.example.com`.
Use the actual hostnames and deployment IDs issued by the fixture. The normal
baseline task withdraws the alias and tears the fixture down; for manual
verification, retain the fixture until the probes are complete.

Issue a disposable certificate with SANs for `control.example.net` and
`*.sites.example.com` from a fixture CA. Keep the private keys in the guest.
Pass the CA to the test client using `--cacert`; do not install it globally.

## Run the reference proxy

Export these settings in the disposable guest. Replace the preview and alias
examples with the actual fixture hostnames. The example uses the Compose
loopback ports by default; if the fixture uses different ports, set
`FIXTURE_CONTROLLER_UPSTREAM`, `FIXTURE_DOKKU_UPSTREAM` and
`FIXTURE_ROUTER_UPSTREAM` to the respective loopback addresses.

```sh
export FIXTURE_MANAGEMENT_HOST=control.example.net
export FIXTURE_PREVIEW_A=demo-a1b2c3d4e5-preview.sites.example.com
export FIXTURE_PREVIEW_B=demo-f6g7h8j9k0-preview.sites.example.com
export FIXTURE_ALIAS=view-demo-qa1ws2ed3r.sites.example.com
export FIXTURE_TLS_CERT=/absolute/private/fixture.pem
export FIXTURE_TLS_KEY=/absolute/private/fixture.key
caddy validate --config examples/ingress/Caddyfile --adapter caddyfile
caddy run --config examples/ingress/Caddyfile --adapter caddyfile
```

The [reference Caddyfile](../examples/ingress/Caddyfile) matches exact hosts,
then returns 404 for anything else. The apps listener has no route to
management. The HTTP upstreams receive the incoming `Host`. The alias uses
the router's data port, never its control port.

## Verify the boundary

From a second shell in the guest, set `FIXTURE_CA` to the public CA file and
export the fixture hostnames there too. `--resolve` routes each request
without DNS and still checks the certificate against the URL hostname.

```sh
curl --noproxy '*' --cacert "$FIXTURE_CA" \
  --resolve "$FIXTURE_MANAGEMENT_HOST:8443:127.0.0.1" \
  "https://$FIXTURE_MANAGEMENT_HOST:8443/api/health"

curl --noproxy '*' --cacert "$FIXTURE_CA" -sS -D - -o /dev/null \
  --resolve "$FIXTURE_ALIAS:9443:127.0.0.2" \
  "https://$FIXTURE_ALIAS:9443/"
```

- Management health returns 200 on the management listener and 404 on the
  apps listener, even with the correct management hostname.
- Both preview hosts and the bound alias return 200 with the expected
  `X-Launchpad-Deployment` headers. The management listener returns 404 for
  an app hostname.
- An unlisted app hostname returns 404 without a deployment identity. After
  withdrawing the alias, the same alias hostname also returns 404 without an
  identity. Do not fall back to Dokku on a router 404.
- Only the recorded loopback listeners are open. No route can reach router
  control, PostgreSQL, Docker or Dokku SSH.

Stop Caddy and tear down only the recorded fixture when finished.

## Rehearsal result

On 2026-11-23 the checked-in reference passed with Caddy 2.6.2 in an isolated
QEMU/KVM guest. This records the tested version, not a production version
recommendation. The client rejected the untrusted CA, then verified HTTPS
with the fixture CA. Management health and sign-in worked on the management
listener; neither listener served the other listener's hostnames. Both
previews and the alias returned the expected identities. Unlisted hosts,
including names shaped like a preview or alias, returned 404. Withdrawing the
alias through the management API returned it to a 404 without fallback.
The deployments, proxy, fixture VM and its keys were removed.

## Adapt to a real installation

Keep management private or behind a trusted access gateway, on a different
registrable domain from apps. Select DNS, HTTPS, the access gateway and apps
visibility for each installation. For dynamic app hostnames, generate routes
from inventory or match disjoint deployment and alias hostname templates.
With template matching, also check that an unregistered but valid-looking
name cannot serve an existing app. Repeat the identity and isolation checks
against the chosen ingress. Enable forwarded-header trust only after checking
proxy behavior and preventing direct access that bypasses it.
