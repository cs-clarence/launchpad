import { randomUUID } from "node:crypto";
import { nameSchema, slugSchema } from "@launchpad-kit/contracts";
import type { Database, OrganizationRole } from "@launchpad-kit/database";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import {
    can,
    canAssignRole,
    ORGANIZATION_ROLES,
    type OrganizationAction,
    type Principal,
} from "./authorization";
import { isUniqueViolation, ServiceError } from "./errors";

type Db = Kysely<Database>;

const roleSchema = z.enum(ORGANIZATION_ROLES);

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
        const detail = parsed.error.issues.map(
            (i) => `${i.path.join(".") || "input"}: ${i.message}`,
        );
        throw new ServiceError("invalid", detail.join("; "));
    }
    return parsed.data;
}

export async function recordAudit(
    db: Db,
    event: {
        actor: Principal;
        action: string;
        targetType: string;
        targetId: string;
        organizationId?: string;
        detail?: string;
    },
) {
    await db
        .insertInto("audit_event")
        .values({
            actor: event.actor.credentialId
                ? `api_key:${event.actor.credentialId}`
                : `user:${event.actor.userId}`,
            action: event.action,
            target_type: event.targetType,
            target_id: event.targetId,
            organization_id: event.organizationId ?? null,
            detail: event.actor.credentialId
                ? JSON.stringify({
                      onBehalfOf: event.actor.userId,
                      ...(event.detail ? { detail: event.detail } : {}),
                  })
                : (event.detail ?? null),
        })
        .execute();
}

// Non-members get not-found, so organization existence is not revealed.
export async function requireMembership(
    db: Db,
    principal: Principal,
    organizationId: string,
    action: OrganizationAction,
): Promise<OrganizationRole> {
    const member = await db
        .selectFrom("member")
        .select("role")
        .where("organizationId", "=", organizationId)
        .where("userId", "=", principal.userId)
        .executeTakeFirst();
    if (!member) {
        throw new ServiceError("not-found", "Organization not found.");
    }
    if (!can(member.role, action)) {
        throw new ServiceError("forbidden", "You do not have permission to do that.");
    }
    return member.role;
}

export async function listMyOrganizations(db: Db, principal: Principal) {
    return db
        .selectFrom("member")
        .innerJoin("organization", "organization.id", "member.organizationId")
        .select(["organization.id", "organization.name", "organization.slug", "member.role"])
        .where("member.userId", "=", principal.userId)
        .orderBy("organization.name")
        .execute();
}

export async function getOrganization(db: Db, principal: Principal, organizationId: string) {
    const role = await requireMembership(db, principal, organizationId, "organization:read");
    const organization = await db
        .selectFrom("organization")
        .select(["id", "name", "slug"])
        .where("id", "=", organizationId)
        .executeTakeFirstOrThrow();
    return { ...organization, role };
}

export const createOrganizationSchema = z.object({
    name: nameSchema,
    slug: slugSchema,
    ownerEmail: z.string().trim().toLowerCase().pipe(z.email()),
});

// Only the instance operator creates organizations, and must name an existing
// user as the first owner; the operator gets no membership from this.
// Access granted by email goes to whoever holds that account. An account found by
// address may belong to a stranger who registered it first (public sign-up, now or
// earlier), so only an account whose address was verified (by accepting an emailed
// invitation) or that the operator provisioned may receive such a grant. This does
// not depend on the current sign-up setting: turning sign-up off does not make an
// account that was registered while it was on any more trustworthy.
async function requireGrantable(db: Db, userId: string) {
    const user = await db
        .selectFrom("user")
        .select("emailVerified")
        .where("id", "=", userId)
        .executeTakeFirst();
    if (user?.emailVerified) {
        return;
    }
    const provisioned = await db
        .selectFrom("audit_event")
        .select("id")
        .where("target_type", "=", "user")
        .where("target_id", "=", userId)
        .where("action", "in", ["user.provisioned", "operator.created"])
        .executeTakeFirst();
    if (!provisioned) {
        throw new ServiceError(
            "invalid",
            "That account's email address is not verified and the operator did not provision it, so it cannot be granted access by email. Invite the address instead.",
        );
    }
}

export async function createOrganization(db: Db, principal: Principal, input: unknown) {
    if (principal.instanceRole !== "operator") {
        throw new ServiceError("forbidden", "Only the instance operator can create organizations.");
    }
    const data = parseInput(createOrganizationSchema, input);
    try {
        return await db.transaction().execute(async (trx) => {
            const owner = await trx
                .selectFrom("user")
                .select("id")
                .where("email", "=", data.ownerEmail)
                .executeTakeFirst();
            if (!owner) {
                throw new ServiceError("invalid", "The owner must be an existing user.");
            }
            await requireGrantable(trx, owner.id);
            const id = randomUUID();
            const now = new Date();
            await trx
                .insertInto("organization")
                .values({
                    id,
                    name: data.name,
                    slug: data.slug,
                    logo: null,
                    createdAt: now,
                    metadata: null,
                })
                .execute();
            await trx
                .insertInto("member")
                .values({
                    id: randomUUID(),
                    organizationId: id,
                    userId: owner.id,
                    role: "owner",
                    createdAt: now,
                })
                .execute();
            await recordAudit(trx, {
                actor: principal,
                action: "organization.created",
                targetType: "organization",
                targetId: id,
                organizationId: id,
            });
            return { id, name: data.name, slug: data.slug };
        });
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new ServiceError("conflict", "That organization slug is taken.");
        }
        throw error;
    }
}

export async function listMembers(db: Db, principal: Principal, organizationId: string) {
    await requireMembership(db, principal, organizationId, "member:read");
    return db
        .selectFrom("member")
        .innerJoin("user", "user.id", "member.userId")
        .select(["user.id as userId", "user.email", "user.name", "member.role"])
        .where("member.organizationId", "=", organizationId)
        .orderBy("user.email")
        .execute();
}

export const addMemberSchema = z.object({
    email: z.string().trim().toLowerCase().pipe(z.email()),
    role: roleSchema,
});

// Offline provisioning: the user must already exist. This grants access; it is
// not proof of mailbox ownership.
export async function addMember(
    db: Db,
    principal: Principal,
    organizationId: string,
    input: unknown,
) {
    // Fail fast, outside the transaction; the real check is repeated under the lock.
    await requireMembership(db, principal, organizationId, "member:manage");
    const data = parseInput(addMemberSchema, input);
    const user = await db
        .selectFrom("user")
        .select("id")
        .where("email", "=", data.email)
        .executeTakeFirst();
    if (!user) {
        throw new ServiceError("invalid", "No user has that email address.");
    }
    await requireGrantable(db, user.id);
    try {
        await db.transaction().execute(async (trx) => {
            // The same lock removeMember takes: without it, a concurrent removal of the
            // actor could land between the permission check and the insert, and a
            // removed owner could add themselves back.
            const members = await trx
                .selectFrom("member")
                .select(["userId", "role"])
                .where("organizationId", "=", organizationId)
                .forUpdate()
                .execute();
            const actor = members.find((m) => m.userId === principal.userId);
            if (!actor || !can(actor.role, "member:manage")) {
                throw new ServiceError("not-found", "Organization not found.");
            }
            if (!canAssignRole(actor.role, data.role)) {
                throw new ServiceError(
                    "forbidden",
                    `Your role cannot assign the ${data.role} role.`,
                );
            }
            await trx
                .insertInto("member")
                .values({
                    id: randomUUID(),
                    organizationId,
                    userId: user.id,
                    role: data.role,
                    createdAt: new Date(),
                })
                .execute();
            await recordAudit(trx, {
                actor: principal,
                action: "member.added",
                targetType: "member",
                targetId: user.id,
                organizationId,
                detail: `role=${data.role}`,
            });
        });
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new ServiceError("conflict", "That user is already a member.");
        }
        throw error;
    }
    return { userId: user.id, role: data.role };
}

// Members may leave; managing others needs member:manage and a role the actor
// could assign. The last owner can never be removed.
export async function removeMember(
    db: Db,
    principal: Principal,
    organizationId: string,
    userId: string,
) {
    const isSelf = userId === principal.userId;
    await requireMembership(
        db,
        principal,
        organizationId,
        isSelf ? "organization:read" : "member:manage",
    );
    await db.transaction().execute(async (trx) => {
        const members = await trx
            .selectFrom("member")
            .select(["id", "userId", "role"])
            .where("organizationId", "=", organizationId)
            .forUpdate()
            .execute();
        // Re-read the actor inside the lock: a concurrent change must not be missed.
        const actor = members.find((m) => m.userId === principal.userId);
        if (!actor || !can(actor.role, isSelf ? "organization:read" : "member:manage")) {
            throw new ServiceError("not-found", "Organization not found.");
        }
        const target = members.find((m) => m.userId === userId);
        if (!target) {
            throw new ServiceError("not-found", "Member not found.");
        }
        if (!isSelf && !canAssignRole(actor.role, target.role)) {
            throw new ServiceError("forbidden", "Your role cannot remove that member.");
        }
        if (target.role === "owner" && members.filter((m) => m.role === "owner").length === 1) {
            throw new ServiceError("conflict", "An organization must keep at least one owner.");
        }
        const deactivated = await trx
            .selectFrom("api_key")
            .select("id")
            .where("organization_id", "=", organizationId)
            .where("member_id", "=", target.id)
            .where("revoked_at", "is", null)
            .where("expires_at", ">", sql<Date>`now()`)
            .execute();
        await trx
            .deleteFrom("member")
            .where("organizationId", "=", organizationId)
            .where("userId", "=", userId)
            .execute();
        for (const key of deactivated) {
            await recordAudit(trx, {
                actor: principal,
                action: "api_key.deactivated",
                targetType: "api_key",
                targetId: key.id,
                organizationId,
                detail: "reason=membership-removed",
            });
        }
        await recordAudit(trx, {
            actor: principal,
            action: "member.removed",
            targetType: "member",
            targetId: userId,
            organizationId,
            detail: `role=${target.role}`,
        });
    });
}
