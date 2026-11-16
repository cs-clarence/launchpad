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
    createdAt: Date;
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

export interface ApiKeyTable {
    id: Generated<string>;
    organization_id: string;
    created_by: string;
    member_id: string | null;
    name: string;
    prefix: string;
    secret_hash: string;
    scopes: string[];
    project_ids: string[] | null;
    created_at: Generated<Date>;
    expires_at: Date;
    revoked_at: Date | null;
    last_used_at: Date | null;
}

export interface ArtifactTable {
    id: Generated<string>;
    organization_id: string;
    digest: string;
    size_bytes: string | number;
    expanded_bytes: string | number;
    entry_count: number;
    storage_key: string;
    created_by: string;
    created_at: Generated<Date>;
    // Set once the stored archive has been collected; the row stays as a record.
    collected_at: Date | null;
}

export interface PreviewTable {
    id: Generated<string>;
    organization_id: string;
    project_id: string;
    slug: string;
    app_name: string;
    hostname: string;
    desired_state: Generated<"active" | "deleting" | "deleted">;
    active_deployment_id: string | null;
    // null: never expires. deleted_at is set exactly when desired_state is "deleted".
    expires_at: Date | null;
    deleted_at: Date | null;
    created_by: string;
    created_at: Generated<Date>;
}

export type DeploymentStatus =
    | "queued"
    | "preparing"
    | "building"
    | "deploying"
    | "verifying"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "reconciliation-needed";

export type DeploymentStep = "app" | "build" | "configure" | "load" | "verify";

export interface DeploymentTable {
    id: Generated<string>;
    organization_id: string;
    preview_id: string;
    artifact_id: string;
    spa: Generated<boolean>;
    status: Generated<DeploymentStatus>;
    attempt: Generated<number>;
    image_tag: string | null;
    failure_code: string | null;
    failure_message: string | null;
    requested_by: string;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    finished_at: Date | null;
    lease_owner: string | null;
    lease_expires_at: Date | null;
    step_done: DeploymentStep | null;
    // A rollback is only ever an intent, never a completed step.
    step_pending: DeploymentStep | "rollback" | null;
}

export interface DeploymentEventTable {
    id: Generated<string>;
    organization_id: string;
    deployment_id: string;
    seq: number;
    phase: string;
    level: Generated<"info" | "warn" | "error">;
    message: string;
    created_at: Generated<Date>;
}

export type DeletionStatus = "queued" | "running" | "succeeded" | "reconciliation-needed";
export type DeletionStep = "destroy" | "images";

export interface DeletionOperationTable {
    id: Generated<string>;
    organization_id: string;
    preview_id: string;
    reason: "manual" | "expired";
    status: Generated<DeletionStatus>;
    attempt: Generated<number>;
    // Only ever goes up, one per claim; `attempt` is the retry budget and can be reset.
    fence: Generated<number>;
    // null: the system (scheduled expiry)
    requested_by: string | null;
    failure_code: string | null;
    failure_message: string | null;
    lease_owner: string | null;
    lease_expires_at: Date | null;
    step_done: DeletionStep | null;
    step_pending: DeletionStep | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    finished_at: Date | null;
}

export interface InstanceStateTable {
    key: string;
    value: string;
    set_at: Generated<Date>;
}

export interface WorkerHeartbeatTable {
    worker_id: string;
    version: string;
    started_at: Generated<Date>;
    last_seen_at: Generated<Date>;
}

export interface IdempotencyKeyTable {
    organization_id: string;
    principal: string;
    endpoint: string;
    key: string;
    request_hash: string;
    resource_id: string | null;
    created_at: Generated<Date>;
    expires_at: Date;
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
    api_key: ApiKeyTable;
    artifact: ArtifactTable;
    preview: PreviewTable;
    deployment: DeploymentTable;
    deployment_event: DeploymentEventTable;
    deletion_operation: DeletionOperationTable;
    worker_heartbeat: WorkerHeartbeatTable;
    instance_state: InstanceStateTable;
    idempotency_key: IdempotencyKeyTable;
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
