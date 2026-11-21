# P6: client and documentation cutover

Large, High risk because the cutover exposes routing and deletion to more clients.
Ship as one PR against the existing immutable app, deployment and alias contracts.
No worker, router, schema, production or P7 rehearsal changes.

The org administrator's request cannot include an asserted outcome. Keep the
instance operator's existing evidence boundary rather than putting router
credentials into the dashboard/API process or trusting a browser attestation.
Retention extension was not in the settled HTTP surface and remains deferred
with automatic retention expiry.

1. Keep session reconciliation a request only. A recent admin/owner session may
   record a request against a held resource in its organization. The audit entry
   is the operator handoff; it neither attests to evidence nor queues a repair.
   Operators still verify the exact router route or Dokku app before using the
   existing commands. Test the role, tenancy, freshness and held-state boundary
   first. Undo: remove the endpoint; audit entries do not alter deployment state.
2. Add SDK transport and shared client workflows, then CLI, MCP and dashboard
   surfaces. Deploy and promotion remain separate; route changes use reserved
   generation and explicit idempotency keys. Verify negative confirmations and
   project boundaries before wiring mutations. Undo with matched pre-cutover
   clients; do not restore the retired preview API.
3. Update installation, upgrade, backup/restore and tooling examples. Run the full
   Omni gate and verify built/packed clients in CI. Do not start local services
   or publish artifacts.
