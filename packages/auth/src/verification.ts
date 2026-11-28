import type { Database } from "@launchpad-kit/database";
import type { Kysely } from "kysely";
import { normalizeEmail } from "./email";
import { UnknownUserError } from "./recovery";

export class EmailVerificationNotAllowedError extends Error {
    constructor() {
        super(
            "Marking an address verified by hand is limited to development controllers " +
                "(LAUNCHPAD_DEVELOPMENT=true, or an app_setting row for `development`). Elsewhere an " +
                "address is verified only by accepting an invitation.",
        );
        this.name = "EmailVerificationNotAllowedError";
    }
}

// Development-only: marks an account's address verified so a seeded controller can exercise email
// recovery, which otherwise goes only to addresses verified by accepting an invitation (see
// docs/decisions/configurable-identity-provisioning.md). The caller resolves the development
// setting through ConfigurationService, so a database row, the environment or the default decides,
// and operator provisioning in production cannot use it to waive verification.
export async function verifyEmailForDevelopment(
    deps: { db: Kysely<Database> },
    input: { email: string; actor: string; development: boolean },
): Promise<{ id: string; email: string; changed: boolean }> {
    if (!input.development) throw new EmailVerificationNotAllowedError();
    const email = normalizeEmail(input.email);
    return deps.db.transaction().execute(async (trx) => {
        const user = await trx
            .selectFrom("user")
            .select(["id", "emailVerified"])
            .where("email", "=", email)
            .executeTakeFirst();
        if (!user) throw new UnknownUserError();
        if (user.emailVerified) return { id: user.id, email, changed: false };
        // Conditional, so two concurrent runs cannot both write an audit event for one change.
        const updated = await trx
            .updateTable("user")
            .set({ emailVerified: true, updatedAt: new Date() })
            .where("id", "=", user.id)
            .where("emailVerified", "=", false)
            .executeTakeFirst();
        if (Number(updated.numUpdatedRows) === 0) return { id: user.id, email, changed: false };
        await trx
            .insertInto("audit_event")
            .values({
                actor: input.actor,
                action: "user.email_verified",
                target_type: "user",
                target_id: user.id,
            })
            .execute();
        return { id: user.id, email, changed: true };
    });
}
