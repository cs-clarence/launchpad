import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "@launchpad/database/testing";
import { createAuth, createMailer, loadAuthConfig } from "../index";
import { type FakeSmtp, mailText, startFakeSmtp } from "../testing";

const BASE = "http://127.0.0.1:3000";
const env = { LAUNCHPAD_AUTH_SECRET: "test-secret-".repeat(4), LAUNCHPAD_BASE_URL: BASE };
let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let smtp: FakeSmtp;

async function addUser(auth: ReturnType<typeof createAuth>, email: string, verified: boolean) {
    const id = randomUUID();
    await testDb.db
        .insertInto("user")
        .values({ id, name: email, email, emailVerified: verified, image: null, role: "user" })
        .execute();
    await testDb.db
        .insertInto("account")
        .values({
            id: randomUUID(),
            accountId: id,
            providerId: "credential",
            userId: id,
            password: await (await auth.$context).password.hash("original-password-1"),
            updatedAt: new Date(),
        })
        .execute();
    return id;
}

// Each call gets its own client address, so Better Auth's per-address limits do
// not interfere with what is being tested.
let nextClient = 1;
const post = (auth: ReturnType<typeof createAuth>, path: string, body: unknown) =>
    auth.handler(
        new Request(`${BASE}/api/auth${path}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                origin: BASE,
                "x-launchpad-client-ip": `10.1.0.${nextClient++}`,
            },
            body: JSON.stringify(body),
        }),
    );

beforeAll(async () => {
    testDb = await createTestDatabase();
    await testDb.migrate();
    smtp = startFakeSmtp();
});
afterAll(async () => {
    smtp.stop();
    await testDb.destroy();
});

describe("email password recovery", () => {
    it("is unavailable without SMTP", async () => {
        const auth = createAuth({ db: testDb.db, config: loadAuthConfig(env) });
        const response = await post(auth, "/request-password-reset", { email: "x@example.com" });
        expect(response.status).toBe(400);
    });

    it("mails a reset link only to verified addresses, with an identical answer for all", async () => {
        const config = loadAuthConfig({
            ...env,
            LAUNCHPAD_SMTP_URL: smtp.url,
            LAUNCHPAD_EMAIL_FROM: "launchpad@example.com",
        });
        const auth = createAuth({ db: testDb.db, config, mailer: createMailer(config) });
        await addUser(auth, "verified@example.com", true);
        await addUser(auth, "provisioned@example.com", false);

        const answers = [];
        for (const email of [
            "verified@example.com",
            "provisioned@example.com",
            "nobody@example.com",
        ]) {
            const response = await post(auth, "/request-password-reset", { email });
            answers.push([response.status, await response.json()]);
        }
        expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
        await expect.poll(() => smtp.messages.length, { timeout: 8000 }).toBe(1);
        expect(smtp.messages[0]!.to).toEqual(["verified@example.com"]);
        const text = mailText(smtp.messages[0]!);
        const token = /reset-password\?token=([^\s]+)/.exec(text)?.[1];
        expect(token).toBeTruthy();
        expect(text).toContain(`${BASE}/reset-password?token=`);

        // Sessions are revoked and only the new password works.
        const first = await post(auth, "/sign-in/email", {
            email: "verified@example.com",
            password: "original-password-1",
        });
        expect(first.status).toBe(200);
        const reset = await post(auth, "/reset-password", {
            newPassword: "a-new-password-12",
            token,
        });
        expect(reset.status).toBe(200);
        expect(await testDb.db.selectFrom("session").select("id").execute()).toHaveLength(0);
        expect(
            (
                await post(auth, "/sign-in/email", {
                    email: "verified@example.com",
                    password: "original-password-1",
                })
            ).status,
        ).toBe(401);
        expect(
            (
                await post(auth, "/sign-in/email", {
                    email: "verified@example.com",
                    password: "a-new-password-12",
                })
            ).status,
        ).toBe(200);
        expect(
            (await post(auth, "/reset-password", { newPassword: "another-new-pass-1", token }))
                .status,
        ).toBe(400);
    });

    it("answers the same when SMTP is unreachable", async () => {
        const config = loadAuthConfig({
            ...env,
            LAUNCHPAD_SMTP_URL: "smtp://127.0.0.1:1",
            LAUNCHPAD_EMAIL_FROM: "launchpad@example.com",
        });
        const auth = createAuth({ db: testDb.db, config, mailer: createMailer(config) });
        // Its own verified user: a missing one would take the unknown-user path and pass
        // without ever attempting delivery.
        await addUser(auth, "unreachable@example.com", true);
        const response = await post(auth, "/request-password-reset", {
            email: "unreachable@example.com",
        });
        expect(response.status).toBe(200);
    });
});

describe("mode switching", () => {
    it("keeps accounts and sessions valid when email is turned on or off", async () => {
        const offConfig = loadAuthConfig(env);
        const off = createAuth({ db: testDb.db, config: offConfig });
        await addUser(off, "switch@example.com", false);
        const signIn = await post(off, "/sign-in/email", {
            email: "switch@example.com",
            password: "original-password-1",
        });
        expect(signIn.status).toBe(200);
        const cookie = signIn.headers
            .getSetCookie()
            .map((c) => c.split(";")[0])
            .join("; ");

        const onConfig = loadAuthConfig({
            ...env,
            LAUNCHPAD_SMTP_URL: smtp.url,
            LAUNCHPAD_EMAIL_FROM: "l@example.com",
        });
        const on = createAuth({ db: testDb.db, config: onConfig, mailer: createMailer(onConfig) });
        for (const auth of [on, off]) {
            const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
            expect(session?.user.email).toBe("switch@example.com");
        }
        const user = await testDb.db
            .selectFrom("user")
            .select("emailVerified")
            .where("email", "=", "switch@example.com")
            .executeTakeFirstOrThrow();
        expect(user.emailVerified).toBe(false); // switching modes never verifies anyone
    });
});

describe("SMTP configuration", () => {
    it("does not let SMTP alone enable invitations or sign-up", () => {
        const config = loadAuthConfig({
            ...env,
            LAUNCHPAD_SMTP_URL: "smtps://mail.example.com",
            LAUNCHPAD_EMAIL_FROM: "l@example.com",
        });
        expect(config.enrollment).toBe("operator");
        expect(config.publicSignup).toBe(false);
    });
});
