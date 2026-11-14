import { Kysely, type Generated } from "kysely";
import { BunSqlDialect, type BunSqlOptions } from "./bun-sql-dialect";

export { migrateToLatest } from "./migrate";

// Auth tables are owned by Better Auth; only columns Launchpad reads or writes
// directly are described. Their column names are camelCase, ours are snake_case.
export interface UserTable {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image: string | null;
    createdAt: Generated<Date>;
    updatedAt: Generated<Date>;
    role: "user" | "operator";
}

export interface AccountTable {
    id: string;
    accountId: string;
    providerId: string;
    userId: string;
    password: string | null;
    createdAt: Generated<Date>;
    updatedAt: Date;
}

export interface SessionTable {
    id: string;
    userId: string;
}

export interface AuditEventTable {
    id: Generated<string>;
    occurred_at: Generated<Date>;
    actor: string;
    action: string;
    target_type: string;
    target_id: string;
    organization_id: string | null;
    detail: string | null;
}

export interface LoginAttemptTable {
    key: string;
    window_start: Date;
    count: number;
}

export interface OrganizationTable {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    createdAt: Date;
    metadata: string | null;
}

export type OrganizationRole = "owner" | "admin" | "deployer" | "viewer";

export interface MemberTable {
    id: string;
    organizationId: string;
    userId: string;
    role: OrganizationRole;
    createdAt: Date;
}

export interface ProjectTable {
    id: Generated<string>;
    organization_id: string;
    slug: string;
    name: string;
    created_by: string;
    created_at: Generated<Date>;
}

export interface InvitationTable {
    id: Generated<string>;
    organization_id: string;
    email: string;
    role: OrganizationRole;
    token_hash: string;
    invited_by: string;
    created_at: Generated<Date>;
    expires_at: Date;
    accepted_at: Date | null;
    revoked_at: Date | null;
}

export interface VerificationTable {
    id: string;
    identifier: string;
    value: string;
    expiresAt: Date;
}

export interface Database {
    verification: VerificationTable;
    organization_invitation: InvitationTable;
    organization: OrganizationTable;
    member: MemberTable;
    project: ProjectTable;
    login_attempt: LoginAttemptTable;
    user: UserTable;
    account: AccountTable;
    session: SessionTable;
    audit_event: AuditEventTable;
}

// Explicit construction only; importing this package never opens a connection.
// One instance serves both Launchpad queries and Better Auth; the composition
// root closes it once with `destroy()`.
export function createDatabase(
    connectionString: string,
    options: BunSqlOptions = {},
): Kysely<Database> {
    return new Kysely<Database>({ dialect: new BunSqlDialect(connectionString, options) });
}
