import type { OrganizationRole } from "@launchpad/database";

export const ORGANIZATION_ROLES = ["owner", "admin", "deployer", "viewer"] as const;

export type OrganizationAction =
    | "organization:read"
    | "organization:delete"
    | "member:read"
    | "member:manage"
    | "project:read"
    | "project:create"
    | "project:delete"
    | "apikey:manage";

const VIEWER: OrganizationAction[] = ["organization:read", "member:read", "project:read"];
const DEPLOYER: OrganizationAction[] = [...VIEWER, "project:create"];
const ADMIN: OrganizationAction[] = [
    ...DEPLOYER,
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

// What an API key may be granted. Deliberately excludes managing members, keys and
// the organization itself: a key can never mint or widen credentials.
export const API_KEY_SCOPES = [
    "organization:read",
    "member:read",
    "project:read",
    "project:create",
    "project:delete",
] as const satisfies readonly OrganizationAction[];
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

// Principals are identities already verified by the transport adapter. The
// instance role grants no access inside an organization.
export interface Principal {
    userId: string;
    instanceRole: "user" | "operator";
}
