import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase, testDatabaseUrl } from "@launchpad/database/testing";
import { createAuth, loadAuthConfig, setupFirstOperator } from "@launchpad/auth";
import { sql } from "kysely";
import { expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const fixture = path.join(import.meta.dirname, "fixtures/schema-014.dump");
const oldUser = "upgrade-fixture@example.invalid";
const operatorEmail = "upgrade-operator@example.invalid";
const operatorPassword = "upgrade-drill-only-password";
const authSecret = "upgrade-drill-secret-".repeat(3);
const containers = new Set<string>();
const dockerEnv = () => ({
    PATH: process.env.PATH,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    DOCKER_TLS_VERIFY: process.env.DOCKER_TLS_VERIFY,
    DOCKER_CERT_PATH: process.env.DOCKER_CERT_PATH,
});

function docker(args: string[], env: NodeJS.ProcessEnv = {}) {
    const result = spawnSync("docker", args, {
        env: { ...dockerEnv(), ...env },
        encoding: "utf8",
        timeout: 60_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
}

function cleanContainer(name: string) {
    // Also handles a `docker run` that timed out after creating the named container.
    const removed = spawnSync("docker", ["rm", "-fv", name], {
        env: dockerEnv(),
        timeout: 30_000,
        encoding: "utf8",
    });
    if (!removed.error && removed.status === 0) {
        containers.delete(name);
        return;
    }
    const absent = spawnSync("docker", ["inspect", name], {
        env: dockerEnv(),
        timeout: 10_000,
        encoding: "utf8",
    });
    if (!absent.error && absent.status !== 0 && absent.stderr.includes("No such object"))
        containers.delete(name);
}

function pgClient(name: "pg_dump" | "pg_restore") {
    const override = process.env[name === "pg_dump" ? "TEST_PG_DUMP" : "TEST_PG_RESTORE"];
    if (override) return `${override} "$@"`;
    const url = new URL(testDatabaseUrl());
    const disposable =
        ["127.0.0.1", "localhost"].includes(url.hostname) &&
        url.port === (process.env.TEST_DB_PORT ?? "55432");
    if (!disposable) return `${name} "$@"`;
    return `docker exec -i -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGUSER -e PGPASSWORD -e PGDATABASE launchpad-test-db ${name} "$@"`;
}

async function admin(url: string, data: string, work: string, command: string, ...args: string[]) {
    // The standalone drill supplies a freshly built controller image. Use its migrations for
    // status and migrate; the integration suite still runs the built admin artifact on its own.
    if (command === "migrate" && process.env.LAUNCHPAD_UPGRADE_IMAGE) {
        const name = `launchpad-upgrade-${randomUUID().slice(0, 8)}-admin`;
        containers.add(name);
        try {
            const result = spawnSync(
                "docker",
                [
                    "run",
                    "--rm",
                    "--name",
                    name,
                    "--network",
                    "host",
                    "-e",
                    "DATABASE_URL",
                    process.env.LAUNCHPAD_UPGRADE_IMAGE,
                    "bun",
                    ".output/admin.mjs",
                    command,
                    ...args,
                ],
                {
                    env: { ...dockerEnv(), DATABASE_URL: url },
                    encoding: "utf8",
                    timeout: 60_000,
                },
            );
            if (result.error) throw result.error;
            return result;
        } finally {
            cleanContainer(name);
        }
    }
    const env = {
        PATH: process.env.PATH,
        HOME: work,
        DATABASE_URL: url,
        LAUNCHPAD_DATA_DIR: data,
        LAUNCHPAD_PG_DUMP: path.join(work, "pg_dump.sh"),
        LAUNCHPAD_PG_RESTORE: path.join(work, "pg_restore.sh"),
    };
    const result = spawnSync("bun", [path.join(root, ".output/admin.mjs"), command, ...args], {
        cwd: work,
        env,
        encoding: "utf8",
        timeout: 60_000,
    });
    if (result.error) throw result.error;
    return result;
}

async function start(url: string, data: string, work: string) {
    // Ask the OS for a free port rather than sharing the other integration suite's port range.
    const net = await import("node:net");
    const socket = net.createServer();
    await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
    const address = socket.address();
    if (!address || typeof address === "string") throw new Error("no loopback port");
    const port = address.port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`;
    const settings = {
        NODE_ENV: "production",
        DATABASE_URL: url,
        LAUNCHPAD_DATA_DIR: process.env.LAUNCHPAD_UPGRADE_IMAGE ? "/data" : data,
        LAUNCHPAD_AUTH_SECRET: authSecret,
        LAUNCHPAD_BASE_URL: base,
        HOST: "127.0.0.1",
        PORT: String(port),
        LAUNCHPAD_DEPLOYMENTS: "off",
        LAUNCHPAD_LIFECYCLE: "off",
    };
    if (process.env.LAUNCHPAD_UPGRADE_IMAGE) {
        const name = `launchpad-upgrade-${randomUUID().slice(0, 8)}-server`;
        containers.add(name);
        try {
            docker(
                [
                    "run",
                    "-d",
                    "--name",
                    name,
                    "--network",
                    "host",
                    ...Object.keys(settings).flatMap((key) => ["-e", key]),
                    process.env.LAUNCHPAD_UPGRADE_IMAGE,
                ],
                settings,
            );
            return {
                base,
                async health() {
                    for (let attempt = 0; attempt < 100; attempt++) {
                        const state = docker(["inspect", "--format", "{{.State.Running}}", name]);
                        if (state !== "true")
                            throw new Error(`controller exited: ${docker(["logs", name])}`);
                        const response = await fetch(`${base}/api/health`).catch(() => undefined);
                        if (response) return response;
                        await new Promise((resolve) => setTimeout(resolve, 200));
                    }
                    throw new Error(`controller never answered: ${docker(["logs", name])}`);
                },
                async stop() {
                    try {
                        docker(["stop", "--time", "20", name]);
                        expect(docker(["inspect", "--format", "{{.State.ExitCode}}", name])).toBe(
                            "0",
                        );
                    } finally {
                        cleanContainer(name);
                    }
                },
            };
        } catch (error) {
            cleanContainer(name);
            throw error;
        }
    }
    const child = spawn("bun", [path.join(root, ".output/server/index.mjs")], {
        cwd: work,
        env: {
            PATH: process.env.PATH,
            HOME: work,
            ...settings,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout?.on("data", (chunk) => (logs += chunk));
    child.stderr?.on("data", (chunk) => (logs += chunk));
    return {
        child,
        base,
        async health() {
            for (let attempt = 0; attempt < 100; attempt++) {
                if (child.exitCode !== null) throw new Error(`controller exited: ${logs}`);
                const response = await fetch(`${base}/api/health`).catch(() => undefined);
                if (response) return response;
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
            throw new Error(`controller never answered: ${logs}`);
        },
        async stop() {
            await stop(child);
        },
    };
}

async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => {
        child.once("exit", () => {
            clearTimeout(kill);
            resolve();
        });
        const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
    });
    child.kill("SIGTERM");
    await exited;
}

// Repeatable without Dokku or a running production controller. The same commands an operator
// runs are invoked from the packaged build; the old dump is frozen, never regenerated by the test.
it(
    "backs up the previous schema, upgrades, restarts, and restores the pre-upgrade backup",
    { timeout: 180_000 },
    async () => {
        const work = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-upgrade-"));
        let source: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
        let target: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
        let server: Awaited<ReturnType<typeof start>> | undefined;
        try {
            if (process.env.LAUNCHPAD_UPGRADE_IMAGE && process.platform !== "linux") {
                throw new Error(
                    "The image upgrade drill needs Linux host networking; use a Linux Docker host.",
                );
            }
            source = await createTestDatabase();
            for (const name of ["pg_dump", "pg_restore"] as const) {
                await fs.writeFile(
                    path.join(work, `${name}.sh`),
                    `#!/bin/sh\n${pgClient(name)}\n`,
                    {
                        mode: 0o700,
                    },
                );
            }
            const dump = await fs.readFile(fixture);
            const pg = new URL(source.url);
            await sql`drop schema public cascade`.execute(source.db);
            const restored = spawnSync(
                path.join(work, "pg_restore.sh"),
                [
                    "--no-owner",
                    "--no-privileges",
                    "--exit-on-error",
                    `--dbname=${decodeURIComponent(pg.pathname.slice(1))}`,
                ],
                {
                    input: dump,
                    env: {
                        PATH: process.env.PATH,
                        PGHOST: pg.hostname,
                        PGPORT: pg.port,
                        PGUSER: decodeURIComponent(pg.username),
                        PGPASSWORD: decodeURIComponent(pg.password),
                        PGDATABASE: decodeURIComponent(pg.pathname.slice(1)),
                    },
                    encoding: "buffer",
                    timeout: 60_000,
                },
            );
            expect(restored.status, restored.stderr.toString()).toBe(0);
            const applied = await sql<{ name: string }>`
                select name from launchpad_migration order by name desc limit 1
            `.execute(source.db);
            expect(applied.rows[0]?.name).toBe("20261116_014_deletion_fence");
            const data = path.join(work, "data");
            const backup = path.join(work, "backup");
            const before = await admin(source.url, data, work, "migrate", "--status");
            expect(before.status).toBe(1);
            expect(before.stdout).toMatch(/pending: [1-9]\d*/);
            expect((await admin(source.url, data, work, "backup", backup)).status).toBe(0);
            expect((await admin(source.url, data, work, "verify-backup", backup)).status).toBe(0);
            expect((await admin(source.url, data, work, "migrate")).status).toBe(0);
            const auth = createAuth({
                db: source.db,
                config: loadAuthConfig({
                    LAUNCHPAD_AUTH_SECRET: authSecret,
                    LAUNCHPAD_BASE_URL: "http://127.0.0.1:1",
                }),
            });
            await setupFirstOperator(
                { db: source.db, auth },
                { email: operatorEmail, name: "Upgrade operator", password: operatorPassword },
            );
            expect((await admin(source.url, data, work, "migrate", "--status")).stdout).toContain(
                "pending: 0",
            );
            server = await start(source.url, data, work);
            expect((await server.health()).status).toBe(200);
            await server.stop();
            server = undefined;
            server = await start(source.url, data, work);
            expect((await server.health()).status).toBe(200);
            const signedIn = await fetch(`${server.base}/api/auth/sign-in/email`, {
                method: "POST",
                headers: { "content-type": "application/json", origin: server.base },
                body: JSON.stringify({ email: operatorEmail, password: operatorPassword }),
            });
            expect(signedIn.status).toBe(200);
            const cookie = signedIn.headers.get("set-cookie")?.split(";")[0];
            expect(cookie).toBeTruthy();
            const status = await fetch(`${server.base}/api/v1/status`, {
                headers: { cookie: cookie! },
            });
            expect(status.status).toBe(200);
            expect(await status.json()).toMatchObject({ dependencies: { database: "ok" } });
            await server.stop();
            server = undefined;
            server = undefined;
            target = await createTestDatabase();
            const after = await admin(
                target.url,
                path.join(work, "restored-data"),
                work,
                "restore",
                backup,
                "--i-have-stopped-the-workers",
            );
            expect(after.status, after.stderr).toBe(0);
            expect(
                (
                    await admin(
                        target.url,
                        path.join(work, "restored-data"),
                        work,
                        "migrate",
                        "--status",
                    )
                ).stdout,
            ).toMatch(/pending: [1-9]\d*/);
            expect(
                (await admin(target.url, path.join(work, "restored-data"), work, "migrate")).status,
            ).toBe(0);
            const checked = await admin(
                target.url,
                path.join(work, "restored-data"),
                work,
                "check-restore",
                "--no-dokku",
            );
            expect(checked.status, checked.stderr).toBe(0);
            expect(
                (
                    await admin(
                        target.url,
                        path.join(work, "restored-data"),
                        work,
                        "migrate",
                        "--status",
                    )
                ).stdout,
            ).toContain("pending: 0");
            const rows = await target.db.selectFrom("user").select("email").execute();
            expect(rows.map((row) => row.email)).toContain(oldUser);
        } finally {
            const cleanupErrors: unknown[] = [];
            if (server) await server.stop().catch((error) => cleanupErrors.push(error));
            for (const name of [...containers]) cleanContainer(name);
            if (containers.size)
                cleanupErrors.push(new Error(`Containers remain: ${[...containers].join(", ")}`));
            const settled = await Promise.allSettled([
                target?.destroy(),
                source?.destroy(),
                fs.rm(work, { recursive: true, force: true }),
            ]);
            for (const result of settled)
                if (result.status === "rejected") cleanupErrors.push(result.reason);
            if (cleanupErrors.length) console.error("Upgrade drill cleanup failed:", cleanupErrors);
        }
    },
);
