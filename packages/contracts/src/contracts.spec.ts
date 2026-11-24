import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
    API_KEY_SCOPES,
    apiKeyStatusSchema,
    apiKeySummarySchema,
    createApiKeySchema,
    createProjectSchema,
    errorSchema,
    keyInfoSchema,
    nameSchema,
    ORGANIZATION_ROLES,
    slugSchema,
    durationSchema,
    parseDuration,
} from "./index";

describe("durations", () => {
    it("reads whole seconds, minutes, hours and days, and nothing else", () => {
        expect(parseDuration("90s")).toBe(90);
        expect(parseDuration("90m")).toBe(5400);
        expect(parseDuration("24h")).toBe(86_400);
        expect(parseDuration("7d")).toBe(604_800);
        for (const bad of [
            "",
            "0d",
            "-1d",
            "1.5h",
            "7",
            "d",
            "7 d",
            " 7d",
            "7D",
            "1w",
            "07d",

            "NaN",
        ]) {
            expect(parseDuration(bad), bad).toBeNull();
            expect(durationSchema.safeParse(bad).success, bad).toBe(false);
        }
        expect(durationSchema.safeParse("24h").success).toBe(true);
        // The same lifetime in other units is accepted; whether it is allowed is the
        // caller's limit, not the parser's.
        expect(parseDuration("31536000s")).toBe(365 * 86_400);
        expect(durationSchema.safeParse("31536000s").success).toBe(true);
        expect(parseDuration("9".repeat(400) + "d")).toBeNull();
    });
});

describe("contracts", () => {
    it("never offers a management scope to API keys", () => {
        expect(API_KEY_SCOPES).not.toContain("apikey:manage");
        expect(API_KEY_SCOPES).not.toContain("member:manage");
        expect(API_KEY_SCOPES).not.toContain("organization:delete");
        expect(ORGANIZATION_ROLES).toEqual(["owner", "admin", "deployer", "viewer"]);
    });

    it("validates the inputs a client builds", () => {
        expect(slugSchema.safeParse("my-site").success).toBe(true);
        expect(slugSchema.safeParse("My Site").success).toBe(false);
        expect(nameSchema.safeParse("bad\u202Ename").success).toBe(false);
        expect(createProjectSchema.safeParse({ name: "A", slug: "a" }).success).toBe(true);
        const key = { name: "ci", scopes: ["project:read"], expiresInDays: 30 };
        expect(createApiKeySchema.safeParse(key).success).toBe(true);
        expect(createApiKeySchema.safeParse({ ...key, scopes: ["member:manage"] }).success).toBe(
            false,
        );
        expect(createApiKeySchema.safeParse({ ...key, expiresInDays: 366 }).success).toBe(false);
        expect(
            createApiKeySchema.safeParse({
                ...key,
                scopes: ["project:create"],
                projectIds: [crypto.randomUUID()],
            }).success,
        ).toBe(false);
        expect(
            createApiKeySchema.safeParse({
                ...key,
                projectIds: [crypto.randomUUID()],
            }).success,
        ).toBe(true);
    });

    it("describes responses strictly, so the controller cannot drift from them", () => {
        const info = {
            id: crypto.randomUUID(),
            name: "ci",
            organizationId: "o",
            scopes: ["project:read"],
            projectIds: null,
            expiresAt: new Date().toISOString(),
        };
        expect(keyInfoSchema.safeParse(info).success).toBe(true);
        expect(keyInfoSchema.safeParse({ ...info, extra: 1 }).success).toBe(false);
        expect(errorSchema.safeParse({ code: "not-found", status: 404, title: "x" }).success).toBe(
            true,
        );
    });

    it("requires a known lifecycle status on key summaries", () => {
        const summary = {
            id: crypto.randomUUID(),
            name: "ci",
            prefix: "lp_abcdef",
            scopes: ["project:read"],
            projectIds: null,
            createdBy: "user-1",
            createdAt: "2026-11-14T00:00:00.000Z",
            expiresAt: "2026-12-14T00:00:00.000Z",
            revokedAt: null,
            lastUsedAt: null,
        };
        expect(apiKeySummarySchema.safeParse(summary).success).toBe(false);
        for (const status of ["active", "expired", "revoked", "inactive"]) {
            expect(apiKeyStatusSchema.safeParse(status).success).toBe(true);
            expect(apiKeySummarySchema.safeParse({ ...summary, status }).success).toBe(true);
            // Metadata remains readable even if a stored scope is unknown to this build.
            expect(
                apiKeySummarySchema.safeParse({
                    ...summary,
                    status,
                    scopes: ["project:read", "unknown:scope"],
                }).success,
            ).toBe(true);
        }
        expect(apiKeySummarySchema.safeParse({ ...summary, status: "unknown" }).success).toBe(
            false,
        );
    });

    it("stays browser-safe: no Node, Bun, database or framework imports", async () => {
        const dir = path.join(import.meta.dirname);
        for (const file of await fs.readdir(dir)) {
            if (!file.endsWith(".ts") || file.endsWith(".spec.ts")) continue;
            const source = await fs.readFile(path.join(dir, file), "utf8");
            const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
            expect(
                imports.filter((i) => i !== "zod" && !i!.startsWith("./")),
                file,
            ).toEqual([]);
        }
    });
});
