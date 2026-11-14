import { createHash } from "node:crypto";
import type { Database } from "@launchpad/database";
import { type Kysely, sql } from "kysely";

export interface ThrottleRule {
    scope: string;
    windowSeconds: number;
    max: number;
}

// Better Auth keys its limiter on IP and path only. These rules add the account:
// one per (client, email) and a looser cap per email across all clients.
export const RESET_RULE: ThrottleRule = { scope: "reset-email", windowSeconds: 3600, max: 3 };

export const LOGIN_RULES = {
    clientAndEmail: { scope: "ip-email", windowSeconds: 60, max: 5 },
    email: { scope: "email", windowSeconds: 600, max: 20 },
} as const;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export async function hit(
    db: Kysely<Database>,
    rule: ThrottleRule,
    subject: string,
): Promise<boolean> {
    const key = `${rule.scope}:${digest(subject)}`;
    const result = await sql<{ count: number }>`
        insert into login_attempt (key, window_start, count)
        values (${key}, now(), 1)
        on conflict (key) do update set
            window_start = case
                when login_attempt.window_start < now() - make_interval(secs => ${rule.windowSeconds})
                then now() else login_attempt.window_start end,
            count = case
                when login_attempt.window_start < now() - make_interval(secs => ${rule.windowSeconds})
                then 1 else login_attempt.count + 1 end
        returning count`.execute(db);
    // Housekeeping: counters idle for a day are meaningless, so occasionally drop them.
    if (Math.random() < 0.02) {
        await sql`delete from login_attempt where window_start < now() - interval '1 day'`.execute(
            db,
        );
    }
    return Number(result.rows[0]?.count ?? 0) <= rule.max;
}

// Records one sign-in attempt and returns whether it may proceed. Every attempt
// counts, successful or not, so the limiter cannot reveal which guess was right.
export async function allowLoginAttempt(
    db: Kysely<Database>,
    attempt: { clientIp: string; email: string },
): Promise<boolean> {
    const email = attempt.email.trim().toLowerCase();
    const first = await hit(db, LOGIN_RULES.clientAndEmail, `${attempt.clientIp}|${email}`);
    const second = await hit(db, LOGIN_RULES.email, email);
    return first && second;
}

// One mailbox cannot be flooded with reset requests from rotating addresses. The
// key is the requested email whether or not an account exists, so the answer
// reveals nothing about accounts.
export async function allowResetRequest(db: Kysely<Database>, email: string): Promise<boolean> {
    return hit(db, RESET_RULE, email.trim().toLowerCase());
}
