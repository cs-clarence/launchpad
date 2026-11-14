# Milestone 2: dashboard API keys

## Assessment and scope

- **Kind:** medium; one dashboard component, the organization loader, a small
  browser HTTP helper and their tests. An additive response-contract change is
  needed first: server-computed key lifecycle status. No database migration or
  authorization-policy expansion.
- **Risk:** high because the UI reveals a new credential. The existing milestone 2
  plan and execution loop are approved; retain its permission model and HTTP API.
- **Unknowns:** ensuring the secret never enters loader data, SSR HTML, history or
  persistent browser storage, and handling a successful issue whose response is
  lost. The existing API returns the secret only from a POST and marks API
  responses no-store. The UI must not retry issuance automatically.
- **Undo:** easy to remove the UI without removing keys or audit history; an exposed
  key must be revoked, not just hidden. No data migration.
- **Execution:** one author, a few bounded steps; independent Opus review of the
  milestone and this approach before completing the milestone.
- **Reassess:** expanding auth, reauthentication semantics, database schemas or the client
  credential format needs a revised plan. Deployment work is out of scope.

## Outcome

An owner or admin opens an organization, lists key metadata, issues a key with
explicit scopes, mandatory expiry and optional project restrictions, saves its
one-time secret, dismisses it, and revokes a key. Other members see neither the
administration UI nor key metadata. All mutation authorization remains in the
existing `/api/v1/organizations/:orgId/api-keys` endpoints.

## Steps and checks

1. First add server-computed `active`, `expired`, `revoked`, `inactive` status
   to key summaries, with revoked > expired > inactive precedence. Inactive means
   the original membership was removed, even if the creator was re-added. Do not
   count inactive keys toward the active cap. Verify every status, precedence,
   remove/re-add and the cap against PostgreSQL. This prerequisite is its own PR.
2. Add safe key metadata to the existing organization loader only when
   `apikey:manage` is allowed. Keep creation out of server loaders and server
   functions; use the existing cookie-authenticated API, whose origin and recent
   session checks already apply. Verify member/admin/outsider server-rendered
   pages and absence of secrets in returned metadata. Explicitly copy metadata
   fields, convert dates to ISO and validate with `apiKeySummarySchema`; never
   spread database rows into loader data. Mark authenticated HTML and server
   functions no-store and test their response headers.
3. Add a dedicated key-administration component to the organization page (no new
   generated route). Show all key statuses, scopes, project limits and expiry.
   Default issuance to `organization:read` and `project:read`; let the operator choose additional
   scopes and projects explicitly. Explain project-limited keys cannot create
   projects and that member-read is organization-wide. Require explicit revoke
   confirmation naming the key and prefix. Hide `project:delete` until there is
   an implemented endpoint; disable `project:create` when limited to projects,
   and limit the picker to 50. Collapse non-active keys separately. Format dates
   as UTC ISO to avoid hydration differences. The loader reports session freshness;
   stale sessions get a checked sign-out action and login link with a return path,
   rather than a login link that immediately redirects the signed-in user back.
4. Issue through POST, validate the creation response, and hold the secret only in
   local component state. Show it once with a clear save-now warning and a dismiss
   action; never copy automatically, log it, put it in a URL, or persist it.
   **Do not invalidate the loader before revealing the secret.** Refresh only
   after the user confirms they saved and dismisses it; refresh failure is separate
   from issuance. Render the component with `key={organization.id}`, and clear its
   secret on pagehide as well as navigation/unmount to avoid bfcache restoration.
   Show the secret in a readonly field outside forms with autocomplete and spellcheck
   off, never in title/aria/data attributes; copy only on an explicit user action.
   Imports in client code must come from browser-safe `@launchpad/contracts`,
   never services/client-core/the bearer-only SDK.
5. Classify attempts in a tested helper as issued, rejected or uncertain. Include
   a timeout. A network failure, 5xx or malformed success is uncertain: never retry
   automatically, GET the list and identify recent keys of the attempted name
   with a revoke action. Parse a successful reveal with a loose schema so an added
   response field cannot discard the secret. Server 4xx errors remain rejected;
   use freshness from the loader, not error-title matching, for sign-in guidance.
6. Add tests for inputs, safe metadata rendering, unauthorized visibility,
   successful response handling and malformed/network/403 responses. Run the Omni
   gate and disposable PostgreSQL integration. No unrequested live server or
   browser preview; document any interaction coverage not exercised.
7. Obtain an independent Opus milestone review, fix verified findings, then follow
   the existing PR → CI/review → merge loop. Stop at milestone 2.

## Residual risks and deferred work

Once a key has been revealed, JavaScript memory and anything the user copies it
to cannot be guaranteed erased. Dismissal removes it from React state/DOM, not
from every possible memory copy. An intercepted or lost reveal requires revocation.
The previously accepted sign-in/operator-reset race is not closed by this page;
do not describe milestone 2 as fixing it. Namespace registration, product renaming,
publishing and milestone 3 are not authorized by this plan.

## Progress

- PR #5 merged as `2a9b2fd`; local `main` synchronized and clean before this plan.
- Lifecycle prerequisite branch: `feat/dashboard-api-keys`.
- Opus reviewed the milestone boundary and this plan; no new exploitable
  credential-boundary hole was found. Incorporated its required plan feedback.
- Lifecycle metadata prerequisite merged in PR #6 as `9b579e3` after the full Omni
  gate, PostgreSQL integration and CI/review passed. Page implementation not started.

## Opus follow-up queue (before declaring milestone 2 complete)

Keep client hardening separate from the lifecycle/dashboard change:

- [ ] Decide and document email-password-reset key revocation; operator reset already
      revokes keys. If email reset revokes them, audit and test the callback.
- [x] Reject half-configured environment credentials rather than silently selecting a
      saved profile. Let environment-only project listing discover its key's org, or
      clearly document required org IDs; keep org-selection precedence explicit.
- [x] Bound actual key-file reads (not only stat size); avoid echoing a key with
      interactive `--key-stdin`; remove terminal controls from human output.
- [x] Resolve stale-lock ownership races and clean up failed temporary writes. Prefer
      safe failure over breaking a lock whose ownership cannot be proven. Use a typed
      busy-store error rather than claiming contention is file corruption.
- [x] Add real loopback SDK redirect/stream-timeout tests, not just mocked fetch.
      Four integration cases passed under real Bun and Node fetch; the default unit
      task stays listener-free. Awaiting PR CI/review.
- [ ] Reject project-limited `project:create` at issuance rather than issuing a key
      whose create scope can never be used.
- [ ] Fix stale role, `/me` and Better Auth key-plugin descriptions in the design,
      plan and ADR. Record key counts in recovery audits and document/audit
      membership-driven deactivation.
- [ ] Record residual and untested behavior explicitly; do not mark these complete
      merely because the dashboard prerequisite PR passes.
