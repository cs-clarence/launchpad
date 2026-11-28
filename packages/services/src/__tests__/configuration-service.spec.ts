import { createTestDatabase } from "@launchpad-kit/database/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigurationService } from "../configuration-service";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
    testDb = await createTestDatabase();
    await testDb.migrate();
});
afterAll(async () => {
    await testDb.destroy();
});
beforeEach(async () => {
    await testDb.db.deleteFrom("app_setting").execute();
});

const read = (env: Record<string, string | undefined> = {}) =>
    new ConfigurationService(testDb.db, env).read();

describe("configuration precedence", () => {
    it("uses the default when neither a row nor the environment sets a value", async () => {
        expect(await read()).toEqual({ development: false });
        expect(await read({ LAUNCHPAD_DEVELOPMENT: "" })).toEqual({ development: false });
    });

    it("reads the environment variable when no row exists", async () => {
        expect(await read({ LAUNCHPAD_DEVELOPMENT: "true" })).toEqual({ development: true });
        expect(await read({ LAUNCHPAD_DEVELOPMENT: "false" })).toEqual({ development: false });
    });

    it("lets a row override the environment, and the environment override it once deleted", async () => {
        await testDb.db
            .insertInto("app_setting")
            .values({ key: "development", value: "false" })
            .execute();
        expect(await read({ LAUNCHPAD_DEVELOPMENT: "true" })).toEqual({ development: false });

        await testDb.db.deleteFrom("app_setting").where("key", "=", "development").execute();
        expect(await read({ LAUNCHPAD_DEVELOPMENT: "true" })).toEqual({ development: true });
    });

    it("refuses an invalid value and names where it came from", async () => {
        await expect(() => read({ LAUNCHPAD_DEVELOPMENT: "yes" })).rejects.toThrow(
            "LAUNCHPAD_DEVELOPMENT must be true or false",
        );

        await testDb.db
            .insertInto("app_setting")
            .values({ key: "development", value: "yes" })
            .execute();
        await expect(() => read()).rejects.toThrow(
            'app_setting "development" must be true or false',
        );
    });

    it("ignores a row it does not know, so a newer deployment cannot stop an older one", async () => {
        await testDb.db
            .insertInto("app_setting")
            .values({ key: "from_the_future", value: "on" })
            .execute();
        expect(await read()).toEqual({ development: false });
    });
});

describe("the app_setting table", () => {
    it("constrains keys and values", async () => {
        const insert = (key: string, value: string) =>
            testDb.db.insertInto("app_setting").values({ key, value }).execute();
        await expect(insert("", "true")).rejects.toThrow();
        await expect(insert("k".repeat(65), "true")).rejects.toThrow();
        await expect(insert("development", "v".repeat(1025))).rejects.toThrow();
        await insert("k".repeat(64), "v".repeat(1024));
    });

    it("moves updated_at forward when a row changes", async () => {
        await testDb.db
            .insertInto("app_setting")
            .values({ key: "development", value: "false" })
            .execute();
        const before = await testDb.db
            .selectFrom("app_setting")
            .select("updated_at")
            .where("key", "=", "development")
            .executeTakeFirstOrThrow();
        await testDb.db
            .updateTable("app_setting")
            .set({ value: "true" })
            .where("key", "=", "development")
            .execute();
        const after = await testDb.db
            .selectFrom("app_setting")
            .select("updated_at")
            .where("key", "=", "development")
            .executeTakeFirstOrThrow();
        expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    });
});
