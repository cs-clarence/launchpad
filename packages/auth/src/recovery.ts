import type { Database } from "@launchpad/database";
import type { Kysely } from "kysely";
import type { Auth } from "./create-auth";
import { InvalidSetupInputError, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./setup";

export class UnknownUserError extends Error {
    constructor() {
        super("No user has that email address.");
        this.name = "UnknownUserError";
    }
}

// Local operator recovery. It is a host-level command, not an HTTP endpoint, and
// does not depend on email. It revokes every session of the user and is audited.
export async function resetPassword(
    deps: { db: Kysely<Database>; auth: Auth },
    input: { email: string; password: string; actor: string },
): Promise<{ id: string; email: string; revokedSessions: number }> {
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
    const email = input.email.trim().toLowerCase();
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
        const revoked = await trx
            .deleteFrom("session")
            .where("userId", "=", user.id)
            .executeTakeFirst();
        await trx
            .insertInto("audit_event")
            .values({
                actor: input.actor,
                action: "user.password_reset",
                target_type: "user",
                target_id: user.id,
            })
            .execute();
        return { id: user.id, email: user.email, revokedSessions: Number(revoked.numDeletedRows) };
    });
}
