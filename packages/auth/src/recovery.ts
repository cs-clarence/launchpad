import type { Database } from "@launchpad-kit/database";
import type { Kysely } from "kysely";
import type { Auth } from "./create-auth";
import { normalizeEmail } from "./email";
import { InvalidSetupInputError } from "./errors";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./setup";

export class UnknownUserError extends Error {
    constructor() {
        super("No user has that email address.");
        this.name = "UnknownUserError";
    }
}

// Local operator recovery. It is a host-level command, not an HTTP endpoint, and
// does not depend on email. It revokes every session and API key of the user and is audited.
export async function resetPassword(
    deps: { db: Kysely<Database>; auth: Auth },
    input: { email: string; password: string; actor: string },
): Promise<{ id: string; email: string; revokedSessions: number; revokedKeys: number }> {
    if (input.password.length < MIN_PASSWORD_LENGTH) {
        throw new InvalidSetupInputError(
            `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        );
    }
    if (input.password.length > MAX_PASSWORD_LENGTH) {
        throw new InvalidSetupInputError(
            `The password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
        );
    }
    const email = normalizeEmail(input.email);
    const passwordHash = await (await deps.auth.$context).password.hash(input.password);

    return deps.db.transaction().execute(async (trx) => {
        const user = await trx
            .selectFrom("user")
            .select(["id", "email"])
            .where("email", "=", email)
            .executeTakeFirst();
        if (!user) {
            throw new UnknownUserError();
        }
        const updated = await trx
            .updateTable("account")
            .set({ password: passwordHash, updatedAt: new Date() })
            .where("userId", "=", user.id)
            .where("providerId", "=", "credential")
            .executeTakeFirst();
        if (Number(updated.numUpdatedRows) === 0) {
            throw new UnknownUserError();
        }
        // An unused emailed reset token must not outlive the operator's reset: Better
        // Auth stores it as `reset-password:<token>` with the user id as its value.
        await trx
            .deleteFrom("verification")
            .where("identifier", "like", "reset-password:%")
            .where("value", "=", user.id)
            .execute();
        const revoked = await trx
            .deleteFrom("session")
            .where("userId", "=", user.id)
            .executeTakeFirst();
        // A compromised account may have issued keys; they are credentials of the account.
        const keys = await trx
            .updateTable("api_key")
            .set({ revoked_at: new Date() })
            .where("created_by", "=", user.id)
            .where("revoked_at", "is", null)
            .executeTakeFirst();
        await trx
            .insertInto("audit_event")
            .values({
                actor: input.actor,
                action: "user.password_reset",
                target_type: "user",
                target_id: user.id,
                detail: JSON.stringify({
                    revokedSessions: Number(revoked.numDeletedRows),
                    revokedKeys: Number(keys.numUpdatedRows),
                }),
            })
            .execute();
        return {
            id: user.id,
            email: user.email,
            revokedSessions: Number(revoked.numDeletedRows),
            revokedKeys: Number(keys.numUpdatedRows),
        };
    });
}

// Offline recovery after a restore. The restored database holds the sessions, API keys,
// emailed tokens and invitations of the moment the backup was taken, not of the moment access
// is reopened. This ends all of them in one transaction. It does not change any password: sign-in
// still works with the restored password, so reset the password of any account that should be
// locked out, and review memberships separately.
export interface RevokedCredentials {
    sessions: number;
    apiKeys: number;
    verificationTokens: number;
    invitations: number;
}

export async function revokeAllCredentials(
    deps: { db: Kysely<Database> },
    input: { actor: string },
): Promise<RevokedCredentials> {
    return deps.db.transaction().execute(async (trx) => {
        const now = new Date();
        const sessions = await trx.deleteFrom("session").executeTakeFirst();
        // Every row is an unused, short-lived token: reset-password and email verification.
        const tokens = await trx.deleteFrom("verification").executeTakeFirst();
        const keys = await trx
            .updateTable("api_key")
            .set({ revoked_at: now })
            .where("revoked_at", "is", null)
            .executeTakeFirst();
        // Only invitations that could still be accepted; accepted history stays as it was.
        const invitations = await trx
            .updateTable("organization_invitation")
            .set({ revoked_at: now })
            .where("revoked_at", "is", null)
            .where("accepted_at", "is", null)
            .executeTakeFirst();
        const counts = {
            sessions: Number(sessions.numDeletedRows),
            apiKeys: Number(keys.numUpdatedRows),
            verificationTokens: Number(tokens.numDeletedRows),
            invitations: Number(invitations.numUpdatedRows),
        };
        await trx
            .insertInto("audit_event")
            .values({
                actor: input.actor,
                action: "instance.credentials_revoked",
                target_type: "instance",
                target_id: "all",
                detail: JSON.stringify(counts),
            })
            .execute();
        return counts;
    });
}
