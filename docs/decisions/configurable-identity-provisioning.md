# Configurable identity provisioning and recovery

Status: accepted by the user. This decision is for contributors implementing
authentication; it does not authorize implementation or runtime changes.

## Context

Launchpad is local-first but supports multiple organizations. Requiring SMTP
would prevent offline installations; supporting only operator provisioning
would unnecessarily exclude verified invitations and self-service recovery.

## Decision

Support both capabilities, configurable per installation:

- Enrollment: operator-only by default, with invitation-based enrollment as an
  option.
- Email: disabled by default, with configurable SMTP.
- Recovery: authenticated local operator reset in both modes, plus email
  self-service recovery when SMTP is enabled.
- Public signup: separately controlled and disabled by default.

Email-dependent flows must be unavailable when email is disabled, and fail
safely when SMTP delivery fails. Never silently waive email verification.
Operator-granted organization membership does not prove mailbox ownership.

Mode changes preserve existing accounts, memberships and sessions. Password
resets are distinct security actions: revoke affected sessions and audit the
operation. Local operator recovery requires host/operator authorization and
must not become an unauthenticated or public account-reset endpoint.

## Consequences

Both offline and SMTP configurations, failures and mode transitions must be
tested. The auth integration spike must prove the framework can enforce these
policies without marking unverified email addresses verified. SMTP transport
configuration alone must never enable invitations or public signup.

Implementation note: v1 allows exactly one instance operator, enforced by a unique
database index. Supporting several operators needs a new migration and a decision.

Implementation note: email recovery mail goes only to verified addresses. An
address is verified by accepting an emailed invitation, never by operator
provisioning, so a mistyped provisioned address cannot be used to take over an
account. The reset response is identical for every address.

### Amendment: the development seed verifies its accounts

Date: 2026-11-28. Approved by the user.

`dev:infra:seed` marks the operator and owner it creates as verified, so email
recovery can be exercised against the local Mailpit; without that, a freshly
seeded development controller could never use the recovery flow. This is a
development exception only. `dev:infra:up` sets `LAUNCHPAD_DEVELOPMENT=true` and
`dev:infra:seed` runs the `verify-email` command for the accounts it created; that
command refuses unless the [configuration service](configuration-service.md)
resolves `development` to true. The development seed skips it for a remote
controller, and operator provisioning elsewhere still never verifies an address.
