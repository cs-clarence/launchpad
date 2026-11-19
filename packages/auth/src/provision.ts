import { randomUUID } from "node:crypto";
import type { Database } from "@launchpad-kit/database";
import type { Kysely } from "kysely";
import type { Auth } from "./create-auth";
import { normalizeEmail } from "./email";
import { InvalidSetupInputError, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./setup";

// Offline provisioning of an ordinary account by the operator. The address is not
// verified: this proves nothing about mailbox ownership.
export async function provisionUser(
    deps: { db: Kysely<Database>; auth: Auth },
    input: { email: string; name: string; password: string; actor: string },
): Promise<{ id: string; email: string }> {
    const email = normalizeEmail(input.email);
    if (
        input.password.length < MIN_PASSWORD_LENGTH ||
        input.password.length > MAX_PASSWORD_LENGTH
    ) {
        throw new InvalidSetupInputError(
            `The password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`,
        );
    }
    const passwordHash = await (await deps.auth.$context).password.hash(input.password);
    const id = randomUUID();

    try {
        return await deps.db.transaction().execute(async (trx) => {
            const taken = await trx
                .selectFrom("user")
                .select("id")
                .where("email", "=", email)
                .executeTakeFirst();
            if (taken) {
                throw new InvalidSetupInputError("A user with that email already exists.");
            }
            await trx
                .insertInto("user")
                .values({
                    id,
                    name: input.name.trim() || email,
                    email,
                    emailVerified: false,
                    image: null,
                    role: "user",
                })
                .execute();
            await trx
                .insertInto("account")
                .values({
                    id: randomUUID(),
                    accountId: id,
                    providerId: "credential",
                    userId: id,
                    password: passwordHash,
                    updatedAt: new Date(),
                })
                .execute();
            await trx
                .insertInto("audit_event")
                .values({
                    actor: input.actor,
                    action: "user.provisioned",
                    target_type: "user",
                    target_id: id,
                })
                .execute();
            return { id, email };
        });
    } catch (error) {
        if ((error as { errno?: string }).errno === "23505") {
            throw new InvalidSetupInputError("A user with that email already exists.");
        }
        throw error;
    }
}
