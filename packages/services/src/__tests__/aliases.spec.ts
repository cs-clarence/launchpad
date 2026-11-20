import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    addMember,
    createAlias,
    createApp,
    createOrganization,
    createProject,
    getAlias,
    listAliases,
    markDeploymentRecoveryBlocked,
    parseAliasConfig,
    parseDeploymentConfig,
    ServiceError,
    type AliasDeps,
    type Principal,
} from "../index";

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let dataDir = "";
let org = "";
let otherOrg = "";
let p1 = "";
let p2 = "";
const people: Record<string, Principal> = {};

const env = {
    LAUNCHPAD_DEPLOYMENTS: "on",
    LAUNCHPAD_ALIASES: "on",
    LAUNCHPAD_BASE_URL: "https://control.example.com",
    LAUNCHPAD_APPS_DOMAIN: "sites.example.net",
    LAUNCHPAD_MAX_APPS: "1000",
};
const deps = (extra: Record<string, string> = {}): AliasDeps => ({
    dataDir,
    settings: parseDeploymentConfig({ ...env, ...extra }),
    aliases: parseAliasConfig({ ...env, ...extra }),
});
const code = (promise: Promise<unknown>) =>
    promise.then(
        () => "ok",
        (error) => (error instanceof ServiceError ? error.code : `unexpected: ${error}`),
    );

async function newUser(name: string, role: "user" | "operator" = "user") {
    const id = randomUUID();
    await testDb.db
        .insertInto("user")
        .values({ id, name, email: `${name}@example.com`, emailVerified: false, role })
        .execute();
    await testDb.db
        .insertInto("audit_event")
        .values({
            actor: "operator-cli",
            action: "user.provisioned",
            target_type: "user",
            target_id: id,
        })
        .execute();
    people[name] = { userId: id, instanceRole: role };
}

let appCount = 0;
const newApp = (project = p1, who = "dee", organization = org) =>
    createApp(
        testDb.db,
        people[who]!,
        organization,
        project,
        { slug: `app-${++appCount}` },
        deps(),
    );

beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-aliases-"));
    testDb = await createTestDatabase();
    await testDb.migrate();
    await newUser("root", "operator");
    for (const name of ["ann", "dee", "vic", "zoe"]) await newUser(name);
    org = (
        await createOrganization(testDb.db, people.root!, {
            name: "Acme",
            slug: "acme",
            ownerEmail: "ann@example.com",
        })
    ).id;
    otherOrg = (
        await createOrganization(testDb.db, people.root!, {
            name: "Beta",
            slug: "beta",
            ownerEmail: "zoe@example.com",
        })
    ).id;
    await addMember(testDb.db, people.ann!, org, { email: "dee@example.com", role: "deployer" });
    await addMember(testDb.db, people.ann!, org, { email: "vic@example.com", role: "viewer" });
    p1 = (await createProject(testDb.db, people.ann!, org, { name: "One", slug: "one" })).id;
    p2 = (await createProject(testDb.db, people.ann!, org, { name: "Two", slug: "two" })).id;
});
afterAll(async () => {
    await testDb.destroy();
    await fs.rm(dataDir, { recursive: true, force: true });
});

describe("aliases", () => {
    const create = (appId: string, slug = "prod", who = "dee", extra = {}, restrictTo?: string[]) =>
        createAlias(testDb.db, people[who]!, org, appId, { slug }, deps(extra), restrictTo);

    it("creates an unbound alias with its own permanent hostname and reservation", async () => {
        const app = await newApp();
        const alias = await create(app.id);
        expect(alias).toMatchObject({
            appId: app.id,
            slug: "prod",
            state: "unbound",
            targetDeploymentId: null,
            reservedGeneration: "0",
            committedGeneration: "0",
        });
        expect(alias.hostname).toMatch(/^view-prod-[a-z0-9]{10}\.sites\.example\.net$/);
        expect(
            await testDb.db
                .selectFrom("hostname_reservation")
                .select(["owner_kind", "owner_id", "released_at"])
                .where("hostname", "=", alias.hostname)
                .executeTakeFirstOrThrow(),
        ).toEqual({ owner_kind: "alias", owner_id: alias.id, released_at: null });
        expect(await getAlias(testDb.db, people.vic!, org, alias.id)).toEqual(alias);
        expect(await listAliases(testDb.db, people.vic!, org, app.id)).toEqual([alias]);
        expect(
            await testDb.db
                .selectFrom("audit_event")
                .select("action")
                .where("target_id", "=", alias.id)
                .executeTakeFirstOrThrow(),
        ).toEqual({ action: "alias.created" });
    });

    it("refuses a duplicate slug, a viewer, another project's key and another organization", async () => {
        const app = await newApp();
        await create(app.id, "stable");
        expect(await code(create(app.id, "stable"))).toBe("conflict");
        expect(await code(create(app.id, "other", "vic"))).toBe("forbidden");
        expect(await code(create(app.id, "other", "dee", {}, [p2]))).toBe("not-found");
        expect(
            await code(
                createAlias(testDb.db, people.zoe!, otherOrg, app.id, { slug: "x" }, deps()),
            ),
        ).toBe("not-found");
        expect(await code(create(app.id, "Not Valid"))).toBe("invalid");
        // The same slug is fine on another app: slugs are unique per app.
        expect(await code(create((await newApp()).id, "stable"))).toBe("ok");
    });

    it("hides aliases from other projects' keys and other organizations", async () => {
        const app = await newApp();
        const alias = await create(app.id);
        expect(await code(getAlias(testDb.db, people.dee!, org, alias.id, [p2]))).toBe("not-found");
        expect(await code(listAliases(testDb.db, people.dee!, org, app.id, [p2]))).toBe(
            "not-found",
        );
        expect(await code(getAlias(testDb.db, people.zoe!, otherOrg, alias.id))).toBe("not-found");
        expect(await code(getAlias(testDb.db, people.dee!, org, "not-a-uuid"))).toBe("not-found");
    });

    it("enforces the per-app limit under a race", async () => {
        const app = await newApp();
        const limits = { LAUNCHPAD_MAX_ALIASES_PER_APP: "2", LAUNCHPAD_MAX_ALIASES: "1000" };
        const results = await Promise.all(
            ["a", "b", "c", "d"].map((slug) => code(create(app.id, slug, "dee", limits))),
        );
        expect(results.filter((result) => result === "ok")).toHaveLength(2);
        expect(results.filter((result) => result === "conflict")).toHaveLength(2);
        expect(await listAliases(testDb.db, people.dee!, org, app.id)).toHaveLength(2);
    });

    it("enforces the organization limit across different apps under a race", async () => {
        const live = Number(
            (
                await testDb.db
                    .selectFrom("app_alias")
                    .select((eb) => eb.fn.countAll<string>().as("n"))
                    .where("organization_id", "=", org)
                    .where("state", "<>", "withdrawn")
                    .executeTakeFirstOrThrow()
            ).n,
        );
        const limits = {
            LAUNCHPAD_MAX_ALIASES_PER_APP: "1",
            LAUNCHPAD_MAX_ALIASES: String(live + 2),
        };
        const apps = await Promise.all([newApp(), newApp(), newApp(), newApp()]);
        const results = await Promise.all(
            apps.map((app) => code(create(app.id, "race", "dee", limits))),
        );
        expect(results.filter((result) => result === "ok")).toHaveLength(2);
        expect(results.filter((result) => result === "conflict")).toHaveLength(2);
    });

    it("answers a malformed app id and an unusable slug with client errors", async () => {
        expect(await code(create("not-a-uuid"))).toBe("not-found");
        expect(await code(listAliases(testDb.db, people.dee!, org, "not-a-uuid"))).toBe(
            "not-found",
        );
        const app = await newApp();
        // A template that starts with the slug cannot render this slug as a valid label.
        const template = { LAUNCHPAD_ALIAS_HOSTNAME_TEMPLATE: "{slug}-{id}-view" };
        expect(await code(create(app.id, "ab--x", "dee", template))).toBe("invalid");
    });

    it("counts only live aliases against the limit", async () => {
        const app = await newApp();
        const limits = { LAUNCHPAD_MAX_ALIASES_PER_APP: "1", LAUNCHPAD_MAX_ALIASES: "1000" };
        const first = await create(app.id, "one", "dee", limits);
        expect(await code(create(app.id, "two", "dee", limits))).toBe("conflict");
        // A withdrawn alias frees its slot but never its hostname.
        await testDb.db
            .updateTable("app_alias")
            .set({ state: "withdrawn", committed_generation: "1", reserved_generation: "1" })
            .where("id", "=", first.id)
            .execute();
        const next = await create(app.id, "one", "dee", limits);
        expect(next.hostname).not.toBe(first.hostname);
        const reservation = await testDb.db
            .selectFrom("hostname_reservation")
            .select(["owner_id", "released_at"])
            .where("hostname", "=", first.hostname)
            .executeTakeFirstOrThrow();
        expect(reservation).toEqual({ owner_id: first.id, released_at: null });
        await expect(
            testDb.db
                .deleteFrom("hostname_reservation")
                .where("hostname", "=", first.hostname)
                .execute(),
        ).rejects.toThrow();
    });

    it("is refused when aliases are off, and while recovery is blocked", async () => {
        const app = await newApp();
        const off = { LAUNCHPAD_ALIASES: "off" };
        expect(await code(create(app.id, "p", "dee", off))).toBe("unavailable");
        await markDeploymentRecoveryBlocked(dataDir);
        try {
            await expect(create(app.id, "q")).rejects.toThrow(/recovery/i);
        } finally {
            await fs.rm(path.join(dataDir, "maintenance"), { recursive: true, force: true });
        }
        expect(await listAliases(testDb.db, people.dee!, org, app.id)).toEqual([]);
    });
});
