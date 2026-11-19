import { createDatabase } from "@launchpad-kit/database";
import { describe, expect, it } from "vitest";
import { bareHostname, createAuth, loadAuthConfig } from "./index";

const env = { LAUNCHPAD_AUTH_SECRET: "unit-secret-".repeat(4) };
const db = createDatabase("postgres://unused@127.0.0.1:1/unused");

describe("authentication configuration", () => {
    it("uses secure, prefixed cookies when the base URL is https", async () => {
        const auth = createAuth({
            db,
            config: loadAuthConfig({ ...env, LAUNCHPAD_BASE_URL: "https://control.example.com" }),
        });
        const context = await auth.$context;
        expect(context.authCookies.sessionToken.name).toMatch(/^__Secure-/);
        expect(context.authCookies.sessionToken.attributes.secure).toBe(true);
        expect(context.authCookies.sessionToken.attributes.domain).toBeUndefined();
    });

    it("pins origin and CSRF checks on regardless of environment", async () => {
        const auth = createAuth({
            db,
            config: loadAuthConfig({ ...env, LAUNCHPAD_BASE_URL: "http://127.0.0.1:3000" }),
        });
        const context = await auth.$context;
        expect(context.skipOriginCheck).toBe(false);
        expect(context.skipCSRFCheck).toBe(false);
    });

    it("rejects invalid settings and SMTP-dependent combinations", () => {
        const base = { ...env, LAUNCHPAD_BASE_URL: "http://127.0.0.1:3000" };
        expect(() => loadAuthConfig({ ...base, LAUNCHPAD_AUTH_SECRET: "short" })).toThrow();
        expect(() => loadAuthConfig({ ...base, LAUNCHPAD_ENROLLMENT: "invitation" })).toThrow(
            /SMTP/,
        );
        expect(() => loadAuthConfig({ ...base, LAUNCHPAD_SMTP_URL: "smtp://x" })).toThrow(
            /together/,
        );
        expect(loadAuthConfig(base).publicSignup).toBe(false);
    });

    it("rejects SMTP URLs that could weaken TLS or enable debug logging", () => {
        const base = {
            ...env,
            LAUNCHPAD_BASE_URL: "http://127.0.0.1:3000",
            LAUNCHPAD_EMAIL_FROM: "l@example.com",
        };
        for (const url of [
            "smtp://mail.example.com?requireTLS=false",
            "smtp://mail.example.com?ignoreTLS=true",
            "smtps://mail.example.com?debug=true&logger=true",
            "http://mail.example.com",
            "not a url",
        ]) {
            expect(() => loadAuthConfig({ ...base, LAUNCHPAD_SMTP_URL: url }), url).toThrow();
        }
        expect(
            loadAuthConfig({
                ...base,
                LAUNCHPAD_SMTP_URL: "smtps://user:p%40ss@mail.example.com:465",
            }).smtp,
        ).not.toBeNull();
    });

    it("passes IPv6 SMTP hosts to Nodemailer without brackets", () => {
        expect(bareHostname(new URL("smtp://[::1]:2525").hostname)).toBe("::1");
        expect(bareHostname("mail.example.com")).toBe("mail.example.com");
        expect(bareHostname("127.0.0.1")).toBe("127.0.0.1");
    });
});
