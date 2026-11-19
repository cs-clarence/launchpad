import { randomUUID } from "node:crypto";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getStatus, ServiceError, type Principal } from "../index";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let operator: Principal;
let member: Principal;
let org = "";

beforeAll(async () => {
    testDb = await createTestDatabase();
    await testDb.migrate();
    const ids = { operator: randomUUID(), member: randomUUID() };
    for (const [name, id] of Object.entries(ids)) {
        await testDb.db
            .insertInto("user")
            .values({
                id,
                name,
                email: `${name}@example.com`,
                emailVerified: false,
                image: null,
                role: name === "operator" ? "operator" : "user",
            })
            .execute();
    }
    operator = { userId: ids.operator, instanceRole: "operator" };
    member = { userId: ids.member, instanceRole: "user" };
    org = randomUUID();
    await testDb.db
        .insertInto("organization")
        .values({ id: org, name: "Org", slug: "org", createdAt: new Date() })
        .execute();
});

afterAll(async () => {
    await testDb.destroy();
});

const artifact = (size: number, collected: boolean) =>
    testDb.db
        .insertInto("artifact")
        .values({
            organization_id: org,
            digest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
            size_bytes: size,
            expanded_bytes: size,
            entry_count: 1,
            storage_key: `artifacts/${"b".repeat(32)}/${randomUUID()}`,
            created_by: operator.userId,
            collected_at: collected ? new Date() : null,
        })
        .execute();

describe("operator status", () => {
    it("is for the instance operator only", async () => {
        await expect(getStatus(testDb.db, member)).rejects.toBeInstanceOf(ServiceError);
        await expect(getStatus(testDb.db, member)).rejects.toMatchObject({ code: "forbidden" });
    });

    it("reports a ready database and no stored artifacts on a fresh instance", async () => {
        const status = await getStatus(testDb.db, operator);
        expect(status.dependencies).toEqual({ database: "ok" });
        expect(status.artifacts).toEqual({ stored: 0, bytes: 0 });
        expect(status.warnings).toEqual([]);
        expect(Number.isNaN(Date.parse(status.generatedAt))).toBe(false);
    });

    it("counts stored archives and leaves collected ones out", async () => {
        await artifact(100, false);
        await artifact(50, false);
        await artifact(9999, true);
        const status = await getStatus(testDb.db, operator);
        expect(status.artifacts).toEqual({ stored: 2, bytes: 150 });
    });
});
