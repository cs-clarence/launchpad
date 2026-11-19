# Keep management private from deployed sites

For an instance operator deciding which network can reach management versus
previews. Launchpad does not configure a tunnel, reverse proxy, DNS or TLS.
Do not expose the controller directly to the public internet: the production
ingress and threat review are [follow-up work](plans/production-compose-follow-up.md).

1. Choose a private management origin, e.g.
   `https://control.example.internal`, and a preview domain on a **different
   registrable domain** from management,
   e.g. `previews.example.net`. Set `LAUNCHPAD_BASE_URL` to the exact management
   origin. (The preview domain setting was removed with the preview runtime; the app
   domain, `LAUNCHPAD_APPS_DOMAIN`, arrives with the immutable model.) The controller
   must not share a cookie origin with untrusted preview content.
2. Bind the controller on a private address. Terminate HTTPS at a trusted
   ingress and restrict access with a VPN or equivalent identity-aware gateway.
   If the proxy appends exactly one client IP to `X-Forwarded-For`, set
   `LAUNCHPAD_TRUSTED_PROXY=true`; otherwise leave it `false`. Do not accept
   caller-controlled forwarding headers. Disable public API docs with
   `LAUNCHPAD_API_DOCS=false` if the management origin can be reached externally.
3. **Tailscale option:** publish only the management ingress to your tailnet
   (or a private tailnet DNS name), with access limited to operators and
   members. Keep Dokku SSH, PostgreSQL and the worker's Docker engine
   similarly private. Tailscale supplies network reachability, not Launchpad
   roles or API-key scopes. Configure TLS and the browser origin consistently
   with `LAUNCHPAD_BASE_URL`.
4. **Cloudflare option:** if using Cloudflare Tunnel or Access, protect the
   management hostname with a restrictive Access policy and a trusted
   HTTPS-to-controller hop. Keep preview traffic on a **separate hostname and
   cookie origin** with its own routing to Dokku. A wildcard preview hostname
   must not route to the controller; check DNS, proxy host rules and certificate
   coverage before enabling deployments. Cloudflare policy does not replace
   Launchpad authentication, and a tunnel alone is not an authorization
   boundary. This is architecture guidance, not an implemented template.
5. Check from an allowed device that management sign-in works over HTTPS and
   from a disallowed device that it cannot reach the controller. Do not put SSH credentials in the controller or client.

If sign-in rejects an origin, correct the browser origin and
`LAUNCHPAD_BASE_URL` instead of loosening the origin guard. See [installation](install.md) and [onboarding](onboarding.md).
