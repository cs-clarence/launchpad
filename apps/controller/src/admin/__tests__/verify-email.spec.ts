import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The command's own module runs the program on import, so the gate is exercised the way an
// operator runs it: a real process, a real database, the real configuration service.
const main = path.join(import.meta.dirname, "..", "main.ts");

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let email: string;

beforeEach(async () => {
    database = await createTestDatabase();
    await database.migrate();
    email = `seed-${randomUUID().slice(0, 8)}@launchpad.local`;
    await database.db
        .insertInto("user")
        .values({
            id: randomUUID(),
            name: email,
            email,
            emailVerified: false,
            image: null,
            role: "user",
        })
        .execute();
});
afterEach(async () => {
    await database?.destroy();
});

const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [main, "verify-email", "--email", email], {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, DATABASE_URL: database.url, ...env },
    });

const verified = async () =>
    (
        await database.db
            .selectFrom("user")
            .select("emailVerified")
            .where("email", "=", email)
            .executeTakeFirstOrThrow()
    ).emailVerified;

const audits = async () =>
    database.db
        .selectFrom("audit_event")
        .select("id")
        .where("action", "=", "user.email_verified")
        .execute();

describe("verify-email admin command", () => {
    it("refuses when the configuration service resolves development to false", async () => {
        const result = run({ LAUNCHPAD_DEVELOPMENT: "false" });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("limited to development controllers");
        expect(await verified()).toBe(false);
        expect(await audits()).toHaveLength(0);
    });

    it("verifies and audits when the environment enables development", async () => {
        const result = run({ LAUNCHPAD_DEVELOPMENT: "true" });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`Verified ${email}.`);
        expect(await verified()).toBe(true);
        expect(await audits()).toHaveLength(1);
    });

    it("lets a database row override a disabled environment", async () => {
        await database.db
            .insertInto("app_setting")
            .values({ key: "development", value: "true" })
            .execute();
        const result = run({ LAUNCHPAD_DEVELOPMENT: "false" });
        expect(result.status).toBe(0);
        expect(await verified()).toBe(true);
    });

    it("is idempotent and audits only the first verification", async () => {
        expect(run({ LAUNCHPAD_DEVELOPMENT: "true" }).status).toBe(0);
        const again = run({ LAUNCHPAD_DEVELOPMENT: "true" });
        expect(again.status).toBe(0);
        expect(again.stdout).toContain("was already verified; nothing changed");
        expect(await audits()).toHaveLength(1);
    });

    it("fails on an invalid setting instead of treating it as disabled", async () => {
        const result = run({ LAUNCHPAD_DEVELOPMENT: "yes" });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("LAUNCHPAD_DEVELOPMENT must be true or false");
        expect(await verified()).toBe(false);
    });
});
