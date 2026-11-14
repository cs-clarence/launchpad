import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "@launchpad/database";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { canAssignRole, ORGANIZATION_ROLES, type Principal } from "./authorization";
import { isUniqueViolation, ServiceError } from "./errors";
import { nameSchema, parseInput, recordAudit, requireMembership } from "./organizations";

type Db = Kysely<Database>;

export interface InvitationDeps {
    // True only when enrollment is "invitation" and a mailer is configured.
    enabled: boolean;
    mailer: { send(message: { to: string; subject: string; text: string }): Promise<void> } | null;
    baseUrl: string;
    // With public sign-up on, an unverified account may be a squatter, so accepting
    // an invitation must not mark an existing account verified.
    publicSignup: boolean;
    hashPassword(password: string): Promise<string>;
}

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Invitations send mail from the controller, so each organization is capped.
export const MAX_INVITATIONS_PER_DAY = 50;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

export const createInvitationSchema = z.object({
    email: emailSchema,
    role: z.enum(ORGANIZATION_ROLES),
});

// Pending: neither accepted nor revoked, and not expired.
const pending = (db: Db) =>
    db
        .selectFrom("organization_invitation")
        .where("accepted_at", "is", null)
        .where("revoked_at", "is", null)
        .where("expires_at", ">", new Date());

export async function createInvitation(
    db: Db,
    principal: Principal,
    organizationId: string,
    input: unknown,
    deps: InvitationDeps,
) {
    const actorRole = await requireMembership(db, principal, organizationId, "member:manage");
    if (!deps.enabled || !deps.mailer) {
        throw new ServiceError("not-found", "Invitations are not enabled.");
    }
    const data = parseInput(createInvitationSchema, input);
    if (!canAssignRole(actorRole, data.role)) {
        throw new ServiceError("forbidden", `Your role cannot assign the ${data.role} role.`);
    }
    const organization = await db
        .selectFrom("organization")
        .select("name")
        .where("id", "=", organizationId)
        .executeTakeFirstOrThrow();
    const existing = await db
        .selectFrom("member")
        .innerJoin("user", "user.id", "member.userId")
        .select("member.id")
        .where("member.organizationId", "=", organizationId)
        .where("user.email", "=", data.email)
        .executeTakeFirst();
    if (existing) {
        throw new ServiceError("conflict", "That user is already a member.");
    }

    const token = randomBytes(32).toString("base64url");
    let id: string;
    try {
        id = await db.transaction().execute(async (trx) => {
            // One writer per organization at a time, so the daily cap and the replace
            // step below cannot be raced by concurrent requests for other addresses.
            await sql`select pg_advisory_xact_lock(hashtextextended(${`invitations:${organizationId}`}, 0))`.execute(
                trx,
            );
            const recent = await trx
                .selectFrom("organization_invitation")
                .select((eb) => eb.fn.countAll<string>().as("count"))
                .where("organization_id", "=", organizationId)
                .where("created_at", ">", new Date(Date.now() - 24 * 60 * 60 * 1000))
                .executeTakeFirstOrThrow();
            if (Number(recent.count) >= MAX_INVITATIONS_PER_DAY) {
                throw new ServiceError(
                    "conflict",
                    "This organization has reached its daily invitation limit.",
                );
            }
            // A newer invitation to the same address replaces the older one, but only if
            // the caller could revoke that one: replacing is revoking.
            const replaced = await trx
                .selectFrom("organization_invitation")
                .select(["id", "role"])
                .where("organization_id", "=", organizationId)
                .where("email", "=", data.email)
                .where("accepted_at", "is", null)
                .where("revoked_at", "is", null)
                .execute();
            if (replaced.some((old) => !canAssignRole(actorRole, old.role))) {
                throw new ServiceError(
                    "forbidden",
                    "Your role cannot replace the pending invitation to that address.",
                );
            }
            if (replaced.length > 0) {
                await trx
                    .updateTable("organization_invitation")
                    .set({ revoked_at: new Date() })
                    .where(
                        "id",
                        "in",
                        replaced.map((old) => old.id),
                    )
                    .execute();
            }
            const row = await trx
                .insertInto("organization_invitation")
                .values({
                    organization_id: organizationId,
                    email: data.email,
                    role: data.role,
                    token_hash: hashToken(token),
                    invited_by: principal.userId,
                    expires_at: new Date(Date.now() + INVITATION_TTL_MS),
                })
                .returning("id")
                .executeTakeFirstOrThrow();
            await recordAudit(trx, {
                actor: principal,
                action: "invitation.created",
                targetType: "invitation",
                targetId: row.id,
                organizationId,
                detail: `role=${data.role}`,
            });
            return row.id;
        });
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new ServiceError(
                "conflict",
                "An invitation to that address is already being created.",
            );
        }
        throw error;
    }

    // Mail goes out after the commit. If delivery fails the invitation is revoked,
    // so no live token exists that nobody received.
    try {
        await deps.mailer.send({
            to: data.email,
            subject: `You are invited to ${organization.name} on Launchpad`,
            text: `You have been invited to join ${organization.name} as ${data.role}.\n\nAccept within 7 days:\n\n${deps.baseUrl}/accept-invitation?token=${token}\n\nIf you did not expect this, ignore this email.`,
        });
    } catch (error) {
        console.error("Invitation email failed", error);
        await db
            .updateTable("organization_invitation")
            .set({ revoked_at: new Date() })
            .where("id", "=", id)
            .execute();
        await recordAudit(db, {
            actor: principal,
            action: "invitation.delivery_failed",
            targetType: "invitation",
            targetId: id,
            organizationId,
        });
        throw new ServiceError("delivery-failed", "The invitation email could not be sent.");
    }
    return { id, email: data.email, role: data.role };
}

export async function listInvitations(db: Db, principal: Principal, organizationId: string) {
    await requireMembership(db, principal, organizationId, "member:manage");
    return pending(db)
        .select(["id", "email", "role", "created_at as createdAt", "expires_at as expiresAt"])
        .where("organization_id", "=", organizationId)
        .orderBy("created_at")
        .execute();
}

export async function revokeInvitation(
    db: Db,
    principal: Principal,
    organizationId: string,
    invitationId: string,
) {
    const actorRole = await requireMembership(db, principal, organizationId, "member:manage");
    if (!z.uuid().safeParse(invitationId).success) {
        throw new ServiceError("not-found", "Invitation not found.");
    }
    const invitation = await pending(db)
        .select(["id", "role"])
        .where("organization_id", "=", organizationId)
        .where("id", "=", invitationId)
        .executeTakeFirst();
    if (!invitation) {
        throw new ServiceError("not-found", "Invitation not found.");
    }
    if (!canAssignRole(actorRole, invitation.role)) {
        throw new ServiceError("forbidden", "Your role cannot revoke that invitation.");
    }
    await db.transaction().execute(async (trx) => {
        const updated = await trx
            .updateTable("organization_invitation")
            .set({ revoked_at: new Date() })
            .where("id", "=", invitation.id)
            .where("accepted_at", "is", null)
            .where("revoked_at", "is", null)
            .executeTakeFirst();
        if (Number(updated.numUpdatedRows) === 0) {
            throw new ServiceError("not-found", "Invitation not found.");
        }
        await recordAudit(trx, {
            actor: principal,
            action: "invitation.revoked",
            targetType: "invitation",
            targetId: invitation.id,
            organizationId,
        });
    });
}

// What the holder of a token may learn before accepting it.
export async function previewInvitation(db: Db, token: string) {
    const invitation = await pending(db)
        .innerJoin("organization", "organization.id", "organization_invitation.organization_id")
        .select([
            "organization_invitation.email as email",
            "organization_invitation.role as role",
            "organization.name as organizationName",
        ])
        .where("token_hash", "=", hashToken(token))
        .executeTakeFirst();
    if (!invitation) {
        throw new ServiceError("not-found", "This invitation is not valid.");
    }
    const user = await db
        .selectFrom("user")
        .select("id")
        .where("email", "=", invitation.email)
        .executeTakeFirst();
    return { ...invitation, accountExists: Boolean(user) };
}

export const acceptInvitationSchema = z.object({
    token: z.string().min(20).max(200),
    name: nameSchema.optional(),
    password: z.string().min(12).max(128).optional(),
});

// Accepting proves control of the mailbox the token was sent to, so the email
// becomes verified. An existing account must be signed in as the invited user;
// a new account is created here and the person signs in afterwards.
export async function acceptInvitation(
    db: Db,
    principal: Principal | null,
    input: unknown,
    deps: Pick<InvitationDeps, "hashPassword" | "publicSignup">,
) {
    const data = parseInput(acceptInvitationSchema, input);
    try {
        return await db.transaction().execute(async (trx) => {
            const invitation = await trx
                .selectFrom("organization_invitation")
                .selectAll()
                .where("token_hash", "=", hashToken(data.token))
                .where("accepted_at", "is", null)
                .where("revoked_at", "is", null)
                .where("expires_at", ">", new Date())
                .forUpdate()
                .executeTakeFirst();
            if (!invitation) {
                throw new ServiceError("not-found", "This invitation is not valid.");
            }
            const user = await trx
                .selectFrom("user")
                .select("id")
                .where("email", "=", invitation.email)
                .executeTakeFirst();

            let userId: string;
            let createdAccount = false;
            if (user) {
                if (!principal || principal.userId !== user.id) {
                    throw new ServiceError("forbidden", "Sign in as the invited user to accept.");
                }
                userId = user.id;
                if (!deps.publicSignup) {
                    await trx
                        .updateTable("user")
                        .set({ emailVerified: true, updatedAt: new Date() })
                        .where("id", "=", user.id)
                        .execute();
                }
            } else {
                if (!data.password) {
                    throw new ServiceError(
                        "invalid",
                        "A password of 12-128 characters is required.",
                    );
                }
                userId = randomUUID();
                createdAccount = true;
                await trx
                    .insertInto("user")
                    .values({
                        id: userId,
                        name: data.name ?? invitation.email,
                        email: invitation.email,
                        emailVerified: true,
                        image: null,
                        role: "user",
                    })
                    .execute();
                await trx
                    .insertInto("account")
                    .values({
                        id: randomUUID(),
                        accountId: userId,
                        providerId: "credential",
                        userId,
                        password: await deps.hashPassword(data.password),
                        updatedAt: new Date(),
                    })
                    .execute();
            }
            await trx
                .insertInto("member")
                .values({
                    id: randomUUID(),
                    organizationId: invitation.organization_id,
                    userId,
                    role: invitation.role,
                    createdAt: new Date(),
                })
                .execute();
            await trx
                .updateTable("organization_invitation")
                .set({ accepted_at: new Date() })
                .where("id", "=", invitation.id)
                .execute();
            await recordAudit(trx, {
                actor: { userId, instanceRole: "user" },
                action: "invitation.accepted",
                targetType: "invitation",
                targetId: invitation.id,
                organizationId: invitation.organization_id,
                detail: `role=${invitation.role};account_created=${createdAccount}`,
            });
            return { organizationId: invitation.organization_id, userId, createdAccount };
        });
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new ServiceError("conflict", "That user is already a member.");
        }
        throw error;
    }
}
