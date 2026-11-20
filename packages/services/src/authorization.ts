import {
    API_KEY_SCOPES as KEY_SCOPES,
    ORGANIZATION_ROLES as ROLES,
} from "@launchpad-kit/contracts";
import type { OrganizationRole } from "@launchpad-kit/database";

export const ORGANIZATION_ROLES = ROLES;

export type OrganizationAction =
    | "organization:read"
    | "organization:delete"
    | "member:read"
    | "member:manage"
    | "project:read"
    | "project:create"
    | "project:delete"
    | "app:read"
    | "app:deploy"
    | "app:delete"
    | "app:promote"
    | "app:alias:manage"
    | "app:shutdown"
    | "apikey:manage";

const VIEWER: OrganizationAction[] = [
    "organization:read",
    "member:read",
    "project:read",
    "app:read",
];
const DEPLOYER: OrganizationAction[] = [
    ...VIEWER,
    "project:create",
    "app:deploy",
    "app:delete",
    "app:promote",
    "app:alias:manage",
];
const ADMIN: OrganizationAction[] = [
    ...DEPLOYER,
    // Destroys every deployment of an app. A key also needs app:delete, app:promote and
    // app:alias:manage (there is no scope for this action of its own).
    "app:shutdown",
    "member:manage",
    "project:delete",
    "apikey:manage",
];
const OWNER: OrganizationAction[] = [...ADMIN, "organization:delete"];

// The single source of organization authorization. See
// docs/decisions/organization-roles-and-operator-access.md.
const MATRIX: Record<OrganizationRole, ReadonlySet<OrganizationAction>> = {
    viewer: new Set(VIEWER),
    deployer: new Set(DEPLOYER),
    admin: new Set(ADMIN),
    owner: new Set(OWNER),
};

export function can(role: OrganizationRole, action: OrganizationAction): boolean {
    return MATRIX[role].has(action);
}

// Owners assign any role; admins assign only roles below their own.
export function canAssignRole(actor: OrganizationRole, target: OrganizationRole): boolean {
    if (actor === "owner") return true;
    if (actor === "admin") return target === "deployer" || target === "viewer";
    return false;
}

// What an API key may be granted (the list lives in the contracts); a compile-time
// check that each scope is a real action.
export const API_KEY_SCOPES = KEY_SCOPES satisfies readonly OrganizationAction[];
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

// Principals are identities already verified by the transport adapter. The
// instance role grants no access inside an organization.
export interface Principal {
    userId: string;
    instanceRole: "user" | "operator";
    // Set when the caller is an API key; audit events then name the key.
    credentialId?: string;
}
