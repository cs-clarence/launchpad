import { randomUUID } from "node:crypto";
import type { Database } from "@launchpad/database";
import { type Kysely, sql } from "kysely";
import type { Auth } from "./create-auth";

// Arbitrary constant: all first-operator setups contend for one lock.
const SETUP_LOCK_KEY = 7_201_411_001;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export class OperatorExistsError extends Error {
    constructor() {
        super("An operator already exists; use the recovery command instead.");
        this.name = "OperatorExistsError";
    }
}

export class InvalidSetupInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidSetupInputError";
    }
}

export interface SetupOperatorInput {
    email: string;
    name: string;
    password: string;
}

// Creates the first operator exactly once. There is no default password and no
// public path to this operation; callers are local operator tooling only.
export async function setupFirstOperator(
    deps: { db: Kysely<Database>; auth: Auth },
    input: SetupOperatorInput,
): Promise<{ id: string; email: string }> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new InvalidSetupInputError("A valid email address is required.");
    }
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
    const context = await deps.auth.$context;
    const passwordHash = await context.password.hash(input.password);
    const id = randomUUID();
    const now = new Date();

    return deps.db.transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(${SETUP_LOCK_KEY})`.execute(trx);
        const existing = await trx
            .selectFrom("user")
            .select("id")
            .where("role", "=", "operator")
            .executeTakeFirst();
        if (existing) {
            throw new OperatorExistsError();
        }
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
                role: "operator",
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
                updatedAt: now,
            })
            .execute();
        await trx
            .insertInto("audit_event")
            .values({
                actor: "operator-cli",
                action: "operator.created",
                target_type: "user",
                target_id: id,
            })
            .execute();
        return { id, email };
    });
}
