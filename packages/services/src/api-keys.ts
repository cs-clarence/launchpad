import { createHash, randomBytes } from "node:crypto";
import type { Database } from "@launchpad/database";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { API_KEY_SCOPES, can, type ApiKeyScope, type Principal } from "./authorization";
import { ServiceError } from "./errors";
import { nameSchema, parseInput, recordAudit, requireMembership } from "./organizations";

type Db = Kysely<Database>;

export const MAX_ACTIVE_KEYS_PER_ORGANIZATION = 100;
export const MAX_KEY_LIFETIME_DAYS = 365;
const KEY_PREFIX = "lp_";
const LAST_USED_GRANULARITY_MS = 5 * 60 * 1000;

export const createApiKeySchema = z.object({
    name: nameSchema,
    scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length),
    projectIds: z.array(z.uuid()).min(1).max(50).optional(),
    expiresInDays: z.number().int().min(1).max(MAX_KEY_LIFETIME_DAYS),
});

const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");

// The secret is shown once, in the creation response, and never stored.
export async function createApiKey(
    db: Db,
    principal: Principal,
    organizationId: string,
    input: unknown,
) {
    const role = await requireMembership(db, principal, organizationId, "apikey:manage");
    const data = parseInput(createApiKeySchema, input);
    const scopes = [...new Set(data.scopes)];
    // No privilege escalation: a key carries only what its creator can do right now.
    const excess = scopes.filter((scope) => !can(role, scope));
    if (excess.length > 0) {
        throw new ServiceError("forbidden", `Your role cannot grant: ${excess.join(", ")}.`);
    }
    const projectIds = data.projectIds ? [...new Set(data.projectIds)] : null;

    const secret = KEY_PREFIX + randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + data.expiresInDays * 86_400_000);

    const id = await db.transaction().execute(async (trx) => {
        // Serialize issuance per organization so the cap cannot be raced past.
        await sql`select pg_advisory_xact_lock(hashtextextended(${`api-keys:${organizationId}`}, 0))`.execute(
            trx,
        );
        if (projectIds) {
            const found = await trx
                .selectFrom("project")
                .select("id")
                .where("organization_id", "=", organizationId)
                .where("id", "in", projectIds)
                .execute();
            if (found.length !== projectIds.length) {
                throw new ServiceError("invalid", "A project does not exist in this organization.");
            }
        }
        const active = await trx
            .selectFrom("api_key")
            .select((eb) => eb.fn.countAll<string>().as("n"))
            .where("organization_id", "=", organizationId)
            .where("revoked_at", "is", null)
            .where("expires_at", ">", new Date())
            .executeTakeFirstOrThrow();
        if (Number(active.n) >= MAX_ACTIVE_KEYS_PER_ORGANIZATION) {
            throw new ServiceError("conflict", "This organization has too many active API keys.");
        }
        const row = await trx
            .insertInto("api_key")
            .values({
                organization_id: organizationId,
                created_by: principal.userId,
                name: data.name,
                prefix: secret.slice(0, KEY_PREFIX.length + 6),
                secret_hash: hashSecret(secret),
                scopes,
                project_ids: projectIds,
                expires_at: expiresAt,
                revoked_at: null,
                last_used_at: null,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        await recordAudit(trx, {
            actor: principal,
            action: "api_key.created",
            targetType: "api_key",
            targetId: row.id,
            organizationId,
            detail: JSON.stringify({ scopes, projectIds, expiresAt: expiresAt.toISOString() }),
        });
        return row.id;
    });
    return { id, secret, name: data.name, scopes, projectIds, expiresAt };
}

export async function listApiKeys(db: Db, principal: Principal, organizationId: string) {
    await requireMembership(db, principal, organizationId, "apikey:manage");
    return db
        .selectFrom("api_key")
        .select([
            "id",
            "name",
            "prefix",
            "scopes",
            "project_ids as projectIds",
            "created_by as createdBy",
            "created_at as createdAt",
            "expires_at as expiresAt",
            "revoked_at as revokedAt",
            "last_used_at as lastUsedAt",
        ])
        .where("organization_id", "=", organizationId)
        .orderBy("created_at", "desc")
        .execute();
}

// Idempotent: revoking a revoked key succeeds and keeps the first revocation time.
export async function revokeApiKey(
    db: Db,
    principal: Principal,
    organizationId: string,
    keyId: string,
) {
    await requireMembership(db, principal, organizationId, "apikey:manage");
    if (!z.uuid().safeParse(keyId).success) {
        throw new ServiceError("not-found", "API key not found.");
    }
    await db.transaction().execute(async (trx) => {
        const key = await trx
            .selectFrom("api_key")
            .select(["id", "revoked_at"])
            .where("id", "=", keyId)
            .where("organization_id", "=", organizationId)
            .forUpdate()
            .executeTakeFirst();
        if (!key) throw new ServiceError("not-found", "API key not found.");
        if (key.revoked_at) return;
        await trx
            .updateTable("api_key")
            .set({ revoked_at: new Date() })
            .where("id", "=", keyId)
            .execute();
        await recordAudit(trx, {
            actor: principal,
            action: "api_key.revoked",
            targetType: "api_key",
            targetId: keyId,
            organizationId,
        });
    });
}

export interface ApiKeyPrincipal {
    keyId: string;
    name: string;
    expiresAt: Date;
    organizationId: string;
    // The key's creator, whose membership bounds everything the key can do.
    principal: Principal;
    // Granted scopes narrowed to what the creator's current role still permits.
    scopes: ApiKeyScope[];
    // null: every project in the organization.
    projectIds: string[] | null;
}

// Resolves a presented secret to what it may do, or null. Every failure is the same
// null so a caller cannot tell a revoked key from an unknown one.
export async function authenticateApiKey(db: Db, secret: string): Promise<ApiKeyPrincipal | null> {
    if (!secret.startsWith(KEY_PREFIX) || secret.length > 128) return null;
    const row = await db
        .selectFrom("api_key")
        .innerJoin("member", (join) =>
            join
                .onRef("member.organizationId", "=", "api_key.organization_id")
                .onRef("member.userId", "=", "api_key.created_by"),
        )
        .innerJoin("user", "user.id", "api_key.created_by")
        .select([
            "api_key.id",
            "api_key.name",
            "api_key.expires_at",
            "api_key.organization_id",
            "api_key.created_by",
            "api_key.scopes",
            "api_key.project_ids",
            "api_key.last_used_at",
            "member.role",
            "user.role as instanceRole",
        ])
        .where("api_key.secret_hash", "=", hashSecret(secret))
        .where("api_key.revoked_at", "is", null)
        .where("api_key.expires_at", ">", new Date())
        .executeTakeFirst();
    if (!row) return null;

    const scopes = row.scopes.filter(
        (scope): scope is ApiKeyScope =>
            (API_KEY_SCOPES as readonly string[]).includes(scope) &&
            can(row.role, scope as ApiKeyScope),
    );
    if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > LAST_USED_GRANULARITY_MS) {
        await db
            .updateTable("api_key")
            .set({ last_used_at: new Date() })
            .where("id", "=", row.id)
            .execute();
    }
    return {
        keyId: row.id,
        name: row.name,
        expiresAt: row.expires_at,
        organizationId: row.organization_id,
        principal: { userId: row.created_by, instanceRole: row.instanceRole },
        scopes,
        projectIds: row.project_ids,
    };
}

// What a key may do is decided here, before any service runs: the organization is the
// key's own (another one is indistinguishable from one that does not exist) and the
// scope was granted. The service that then runs still checks the creator's role.
export function requireKeyAccess(key: ApiKeyPrincipal, organizationId: string, scope: ApiKeyScope) {
    if (organizationId !== key.organizationId) {
        throw new ServiceError("not-found", "Organization not found.");
    }
    if (!key.scopes.includes(scope)) {
        throw new ServiceError("forbidden", "This API key does not have that permission.");
    }
}
