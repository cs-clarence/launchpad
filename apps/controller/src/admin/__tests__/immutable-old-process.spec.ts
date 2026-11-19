import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SQL } from "bun";
import { createTestDatabase } from "@launchpad-kit/database/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// What an OLD (pre-model) process does after cutover. The code under test is the real
// services/database source of commit e03c542, extracted from git into a temporary tree
// whose @launchpad-kit/* imports resolve to that tree, never to the current packages.
const BASELINE = "e03c54257ebe14926da4e50d2ba58fe324e5b4bb";
const SOURCE_HASHES: Record<string, string> = {
    "packages/services/src/deployments.ts":
        "d130632341a6d1418bf028a3946c51a3d9ce9f913c0cb10a583d2e28387fed48",
    "packages/services/src/deletions.ts":
        "850dfcb86d31d2fad5515f20b2ffecaa10131b83d893da68ffd2a9be2716ded7",
    "packages/services/src/artifact-gc.ts":
        "aeb8d63f47e41ddc12d208d5c8f6f2d9a35e3a315754222b2a22191a69214ffc",
};
const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const retirement = await fs.readFile(
    new URL("./fixtures/immutable-retirement.sql", import.meta.url),
    "utf8",
);
const model = await fs.readFile(new URL("./fixtures/immutable-model.sql", import.meta.url), "utf8");

const OLD_RUNNER = `
import { createDatabase, assertSchemaCurrent } from "@launchpad-kit/database";
import { claimNext, claimDeletion, collectArtifacts } from "@launchpad-kit/services";
// Isolation: old code may only import old code. Today the baseline and current sources are
// byte-identical, so without this a broken relink would pass silently.
const base = process.env.LAUNCHPAD_BASELINE_DIR;
const resolved = {
    services: import.meta.resolve("@launchpad-kit/services"),
    database: import.meta.resolve("@launchpad-kit/database"),
};
for (const [name, url] of Object.entries(resolved)) {
    if (!new URL(url).pathname.startsWith(base + "/packages/")) {
        console.log(JSON.stringify({ ok: false, error: "isolation: " + name + " resolved to " + url }));
        process.exit(0);
    }
}
if (process.argv[2] === "resolve") {
    console.log(JSON.stringify({ ok: true, value: resolved }));
    process.exit(0);
}
const db = createDatabase(process.env.DATABASE_URL, { max: 1 });
const run = {
    claim: () => claimNext(db, "old-worker", { enabled: true }),
    deletion: () => claimDeletion(db, "old-worker", { enabled: true }),
    collect: () => collectArtifacts(db, { dataDir: process.env.LAUNCHPAD_DATA_DIR, retentionSeconds: 0 }),
    schema: () => assertSchemaCurrent(db),
}[process.argv[2]];
try {
    console.log(JSON.stringify({ ok: true, value: (await run()) ?? null }));
} catch (error) {
    console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
} finally {
    await db.destroy();
}
`;

let baseline = "";
let baselineReal = "";
let source: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let dataDir = "";
let actor = "";
let org = "";
let project = "";
let artifact = { id: "", file: "" };
const db = () => source!.db;

function git(args: string[], cwd = repoRoot) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
}

beforeAll(async () => {
    const parent = (await fs.stat("/tmp/opencode").catch(() => null))
        ? "/tmp/opencode"
        : os.tmpdir();
    // A shallow clone does not hold the historical commit: say so instead of failing obscurely.
    const present = spawnSync("git", ["cat-file", "-e", `${BASELINE}^{commit}`], { cwd: repoRoot });
    if (present.status !== 0) {
        throw new Error(
            `Commit ${BASELINE} is not in this clone. Fetch full history (git fetch --unshallow) to run the old-process tests.`,
        );
    }
    baseline = await fs.mkdtemp(path.join(parent, "lp-baseline-"));
    baselineReal = await fs.realpath(baseline);
    const archive = spawnSync(
        "sh",
        ["-c", `git archive ${BASELINE} packages package.json | tar -x -C "${baseline}"`],
        { cwd: repoRoot, encoding: "utf8" },
    );
    if (archive.status !== 0) throw new Error(`baseline extraction failed: ${archive.stderr}`);
    // Provenance: the extracted files are exactly the reviewed historical blobs.
    for (const [file, expected] of Object.entries(SOURCE_HASHES)) {
        const actual = createHash("sha256")
            .update(await fs.readFile(path.join(baseline, file)))
            .digest("hex");
        expect(actual, file).toBe(expected);
    }
    // Third-party modules come from the current install; workspace packages are
    // re-linked into the BASELINE tree so old code can only import old code.
    await fs.symlink(path.join(repoRoot, "node_modules"), path.join(baseline, "node_modules"));
    const packages = await fs.readdir(path.join(baseline, "packages"));
    for (const name of packages) {
        const current = path.join(repoRoot, "packages", name, "node_modules");
        const entries = await fs.readdir(current).catch(() => [] as string[]);
        const target = path.join(baseline, "packages", name, "node_modules");
        await fs.mkdir(path.join(target, "@launchpad-kit"), { recursive: true });
        for (const entry of entries) {
            if (entry === ".bin") continue;
            if (entry === "@launchpad-kit" || entry === "@launchpad") continue;
            await fs.symlink(
                await fs.realpath(path.join(current, entry)),
                path.join(target, entry),
            );
        }
        for (const sibling of packages) {
            await fs.symlink(
                path.join(baseline, "packages", sibling),
                path.join(target, "@launchpad-kit", sibling),
            );
        }
    }
    await fs.writeFile(path.join(baseline, "packages/services/old-runner.ts"), OLD_RUNNER);
});

afterAll(async () => {
    if (baseline) await fs.rm(baseline, { recursive: true, force: true });
});

async function oldProcess(
    command: "claim" | "deletion" | "collect" | "schema" | "resolve",
    url = source!.url,
) {
    const result = spawnSync("bun", ["old-runner.ts", command], {
        cwd: path.join(baseline, "packages/services"),
        env: {
            PATH: process.env.PATH,
            DATABASE_URL: url,
            LAUNCHPAD_DATA_DIR: dataDir,
            LAUNCHPAD_BASELINE_DIR: baselineReal,
        },
        encoding: "utf8",
        timeout: 60_000,
    });
    if (result.error) throw result.error;
    const line = result.stdout.trim().split("\n").at(-1) ?? "";
    try {
        return JSON.parse(line) as { ok: boolean; value?: unknown; error?: string };
    } catch {
        throw new Error(`old runner gave no result: ${result.stdout}\n${result.stderr}`);
    }
}

beforeEach(async () => {
    source = await createTestDatabase();
    await source.migrate();
    dataDir = await fs.mkdtemp(path.join(path.dirname(baseline), "lp-old-data-"));
    actor = randomUUID();
    org = randomUUID();
    await db()
        .insertInto("user")
        .values({
            id: actor,
            name: "Old process",
            email: "old@example.invalid",
            emailVerified: false,
            role: "user",
        })
        .execute();
    await db()
        .insertInto("organization")
        .values({ id: org, name: "Org", slug: "org", createdAt: new Date("2026-01-01T00:00:00Z") })
        .execute();
    project = (
        await db()
            .insertInto("project")
            .values({ organization_id: org, slug: "site", name: "Site", created_by: actor })
            .returning("id")
            .executeTakeFirstOrThrow()
    ).id;
    // An old, unreferenced archive: under the OLD rules it is collectable at once.
    const owner = "b".repeat(32);
    const digest = "a".repeat(64);
    const key = `artifacts/${owner}/${digest}.tar.gz`;
    const file = path.join(dataDir, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "archive");
    const created = await db()
        .insertInto("artifact")
        .values({
            organization_id: org,
            digest,
            size_bytes: 7,
            expanded_bytes: 7,
            entry_count: 1,
            storage_key: key,
            created_by: actor,
            created_at: new Date("2020-01-01T00:00:00Z"),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    artifact = { id: created.id, file };
});

afterEach(async () => {
    await source?.destroy();
    source = undefined;
    await fs.rm(dataDir, { recursive: true, force: true });
});

const cutover = () =>
    db()
        .transaction()
        .execute(async (trx) => {
            await sql.raw(retirement).execute(trx);
            await sql.raw(model).execute(trx);
        });

describe("old (e03c542) processes against the cut-over schema", () => {
    it("resolves its workspace packages inside the extracted baseline tree, never the current ones", async () => {
        const outcome = await oldProcess("resolve");
        expect(outcome.ok).toBe(true);
        const resolved = outcome.value as Record<string, string>;
        for (const url of Object.values(resolved)) {
            expect(new URL(url).pathname.startsWith(`${baselineReal}/packages/`)).toBe(true);
            expect(new URL(url).pathname.startsWith(`${repoRoot}/packages/`)).toBe(false);
        }
    });

    it("control: before cutover the real old claim and GC do act, so the later refusals are meaningful", async () => {
        const preview = await db()
            .insertInto("preview")
            .values({
                organization_id: org,
                project_id: project,
                slug: "live",
                app_name: "lp-0123456789",
                hostname: "live.old.example.net",
                created_by: actor,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        await db()
            .insertInto("deployment")
            .values({
                organization_id: org,
                preview_id: preview.id,
                artifact_id: artifact.id,
                requested_by: actor,
            })
            .execute();
        // A queued deletion of a second preview: the old deletion claim acts before cutover.
        const going = await db()
            .insertInto("preview")
            .values({
                organization_id: org,
                project_id: project,
                slug: "going",
                app_name: "lp-9876543210",
                hostname: "going.old.example.net",
                created_by: actor,
                desired_state: "deleting",
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        await db()
            .insertInto("deletion_operation")
            .values({
                organization_id: org,
                preview_id: going.id,
                reason: "manual",
                requested_by: actor,
            })
            .execute();
        const deletion = await oldProcess("deletion");
        expect(deletion.ok).toBe(true);
        expect(deletion.value).toMatchObject({ previewId: going.id, attempt: 1 });
        await db().deleteFrom("deletion_operation").execute();
        const claimed = await oldProcess("claim");
        expect(claimed.ok).toBe(true);
        expect(claimed.value).toMatchObject({ attempt: 1 });
        // The archive is referenced by a live preview's deployment, so it is not collected.
        const collected = await oldProcess("collect");
        expect(collected).toEqual({ ok: true, value: { collected: [] } });
        // The old claim wrote progress events, which is itself proof that it acted.
        await db().deleteFrom("deployment_event").execute();
        await db().deleteFrom("deployment").execute();
        await db().deleteFrom("preview").execute();
        // Unreferenced, the same old GC does collect and remove it.
        const free = await oldProcess("collect");
        expect(free).toEqual({ ok: true, value: { collected: [artifact.id] } });
        await expect(fs.stat(artifact.file)).rejects.toThrow();
    });

    it("an old worker cannot claim a queued NEW deployment: the old table no longer exists", async () => {
        await cutover();
        const app = randomUUID();
        await sql`insert into app (id, organization_id, project_id, slug, created_by)
            values (${app}, ${org}, ${project}, 'site', ${actor})`.execute(db());
        const id = randomUUID();
        await db()
            .transaction()
            .execute(async (trx) => {
                await sql`insert into hostname_reservation (hostname, owner_kind, owner_id, organization_id)
                values ('d.apps.example.net', 'deployment', ${id}, ${org})`.execute(trx);
                await sql`insert into dokku_name_reservation (app_name, owner_kind, owner_id, organization_id)
                values ('lp-abcdefghij', 'deployment', ${id}, ${org})`.execute(trx);
                await sql`insert into immutable_deployment
                (id, organization_id, app_id, artifact_id, hostname, app_name, requested_by, preview_expires_at)
                values (${id}, ${org}, ${app}, ${artifact.id}, 'd.apps.example.net', 'lp-abcdefghij',
                    ${actor}, now() + interval '7 days')`.execute(trx);
            });
        const before = (await sql`select * from immutable_deployment`.execute(db())).rows;
        const outcome = await oldProcess("claim");
        expect(outcome.ok).toBe(false);
        expect(outcome.error).toMatch(/relation "deployment" does not exist/);
        expect((await sql`select * from immutable_deployment`.execute(db())).rows).toEqual(before);
    });

    it("an old worker cannot claim a NEW deletion operation", async () => {
        await cutover();
        const outcome = await oldProcess("deletion");
        expect(outcome.ok).toBe(false);
        expect(outcome.error).toMatch(/relation "deletion_operation" does not exist/);
    });

    it("old artifact GC fails closed and leaves a collectable archive and its row alone", async () => {
        await cutover();
        const outcome = await oldProcess("collect");
        expect(outcome.ok).toBe(false);
        expect(outcome.error).toMatch(/relation "(deployment|preview)" does not exist/);
        await expect(fs.readFile(artifact.file, "utf8")).resolves.toBe("archive");
        const row = await db()
            .selectFrom("artifact")
            .select("collected_at")
            .where("id", "=", artifact.id)
            .executeTakeFirstOrThrow();
        expect(row.collected_at).toBeNull();
    });

    it("the old startup schema check passes UNTIL migration 018 is recorded, then refuses", async () => {
        await cutover();
        // Finding: the SQL fixtures record no migration, so on their own they give an old
        // binary NO startup refusal. The real migration must record 018.
        expect(await oldProcess("schema")).toEqual({ ok: true, value: null });
        await sql`insert into launchpad_migration (name, timestamp)
            values ('20261119_018_immutable_deployment_model', now()::text)`.execute(db());
        const refused = await oldProcess("schema");
        expect(refused.ok).toBe(false);
        expect(refused.error).toMatch(/migrations this version does not know/);
        expect(refused.error).toContain("20261119_018_immutable_deployment_model");
    });
});

describe("database login fencing mechanics (test-only role)", () => {
    const role = `lp_test_old_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const password = randomUUID();
    const urlFor = () => {
        const url = new URL(source!.url);
        url.username = role;
        url.password = password;
        return url.toString();
    };

    beforeEach(async () => {
        await sql.raw(`create role ${role} login password '${password}'`).execute(db());
        await sql
            .raw(`grant connect on database "${new URL(source!.url).pathname.slice(1)}" to ${role}`)
            .execute(db());
        await sql.raw(`grant usage on schema public to ${role}`).execute(db());
        await sql.raw(`grant select on all tables in schema public to ${role}`).execute(db());
    });

    afterEach(async () => {
        if (!source) return;
        await sql.raw(`reassign owned by ${role} to current_user`).execute(db());
        await sql.raw(`drop owned by ${role}`).execute(db());
        await sql.raw(`drop role ${role}`).execute(db());
    });

    it("NOLOGIN plus backend termination ends a held old session and refuses reconnects", async () => {
        const held = new SQL({ url: urlFor(), max: 1 });
        try {
            await held`select 1`;
            const sessions = () =>
                sql<{ n: number }>`select count(*)::int as n from pg_stat_activity
                    where usename = ${role}`.execute(db());
            expect((await sessions()).rows[0]!.n).toBeGreaterThan(0);

            // The operator procedure: fence the login, then end its sessions, then verify.
            await sql.raw(`alter role ${role} nologin`).execute(db());
            await sql`select pg_terminate_backend(pid) from pg_stat_activity
                where usename = ${role}`.execute(db());
            for (let i = 0; i < 20 && (await sessions()).rows[0]!.n > 0; i++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            expect((await sessions()).rows[0]!.n).toBe(0);

            await expect(held`select 1`).rejects.toThrow();
            const retry = new SQL({ url: urlFor(), max: 1 });
            try {
                await expect(retry`select 1`).rejects.toThrow(/is not permitted to log in/);
            } finally {
                await retry.close().catch(() => undefined);
            }
        } finally {
            await held.close().catch(() => undefined);
        }
    });

    it("terminating sessions alone is not a fence: the old login reconnects on a new backend", async () => {
        const pids = async () =>
            (
                await sql<{ pid: number }>`select pid from pg_stat_activity
                    where usename = ${role}`.execute(db())
            ).rows.map((row) => row.pid);
        const first = new SQL({ url: urlFor(), max: 1 });
        try {
            await first`select 1`;
            const before = await pids();
            expect(before.length).toBeGreaterThan(0);
            await sql`select pg_terminate_backend(pid) from pg_stat_activity
                where usename = ${role}`.execute(db());
            for (let i = 0; i < 20 && (await pids()).some((pid) => before.includes(pid)); i++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            expect((await pids()).some((pid) => before.includes(pid))).toBe(false);
            const again = new SQL({ url: urlFor(), max: 1 });
            try {
                await expect(again`select 1`).resolves.toBeDefined();
                const after = await pids();
                expect(after.length).toBeGreaterThan(0);
                expect(after.some((pid) => before.includes(pid))).toBe(false);
            } finally {
                await again.close().catch(() => undefined);
            }
        } finally {
            await first.close().catch(() => undefined);
        }
    });
});
