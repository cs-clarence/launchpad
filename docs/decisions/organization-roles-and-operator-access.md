# Organization roles, operator access and preview domain

Status: accepted by the user on 2026-11-14. For contributors implementing
organization authorization. Informed by Vercel's team roles (owner, member,
developer, viewer; read-only roles are explicit) and its separate preview domain.

## Decision

- Organization roles are `owner`, `admin`, `deployer` and `viewer`:
    - viewer reads organization, members and projects;
    - deployer also creates projects and (later) deploys and creates API keys;
    - admin also manages members (assigning only deployer or viewer) and deletes projects;
    - owner also assigns any role, including owner, and deletes the organization.
- The instance operator creates organizations and recovers accounts. The
  operator has no automatic access inside any organization; reading or changing
  organization data requires an explicit membership. A read-only support role may
  be added later as its own decision.
- Previews are served from a registrable domain separate from the controller.
  Controller cookies stay host-only. A same-parent-domain setup is documented as
  weaker and unsupported by default.

## Consequences

- One pure role/action matrix in `packages/services` is the only source of
  authorization; every service call receives the caller and organization.
- A non-member gets 404, not 403, for organization resources.
- Better Auth's organization endpoints use its own role model, so
  `/api/auth/organization/*` is not reachable; organization changes go through
  Launchpad's API. Invitations (SMTP mode) will reopen specific endpoints
  deliberately in their own change.
- The last owner of an organization cannot be removed.

## API keys

Keys are org-owned rows in `api_key`, not Better Auth's key plugin, so authorization
stays in `packages/services`. Admins and owners (`apikey:manage`) issue and revoke
them. A key's scopes are a subset of read/create/delete actions that excludes member,
key and organization management, so a key cannot mint or widen credentials. At issue,
every scope must be permitted to the creator's role; on each use the scopes are
narrowed to the creator's current role, and a key whose creator left the organization
is dead for good: a key is bound to the creator's membership row, so adding the same user
back later does not revive it. Operator password recovery revokes the user's keys along
with their sessions. Admins can list and revoke any key in the organization, including an
owner's. Issuing a key needs a session created in the last 15 minutes. A key never carries
the operator flag, and audit events name the key (`api_key:<id>`) with the creator in the
detail. A request authenticated just before a revocation commits still completes. Expiry is mandatory (at most 365 days), secrets are revealed once and stored
as hashes, and issuing and revoking are audited.
