import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createDocker, dokkuIdle, randomHex, type Resources } from "./harness";

type Options = {
    r: Resources;
    fixture: NonNullable<Resources["restore"]>;
    docker: ReturnType<typeof createDocker>["docker"];
    databaseUrl: string;
    stateVolume: string;
    routerEnv: string[];
    waitForRouter: () => Promise<void>;
    sleep: (ms: number) => Promise<void>;
};

const BACKUP = "/restore/backup";
const MARKER = "/data/maintenance/deployment-recovery-blocked";
const RECOVERY_WAIT_MS = 25 * 60_000;
// Exceed both the 290-second dispatch bound and the five-minute deletion lease.
const WRITER_DRAIN_MS = 301_000;

export function createRestoreDrill({
    r,
    fixture,
    docker,
    databaseUrl,
    stateVolume,
    routerEnv,
    waitForRouter,
    sleep,
}: Options) {
    const folder = `${r.dir}/${fixture.directory}`;
    // Docker reads this host-owned file before starting the unprivileged container.
    const override = `${r.dir}/restore.env`;
    const dataDir = `${folder}/data`;
    const credentials = `${r.dir}/credentials`;
    const restored = new URL(databaseUrl);
    restored.pathname = `/${fixture.database}`;
    const safe = (text: string) => text.replaceAll(restored.password, "[redacted]");

    const admin = async (target: "source" | "restored", args: string[]) => {
        const result = await docker(
            [
                "run",
                "--rm",
                "--network",
                `container:${r.containers.proxy}`,
                "--env-file",
                `${r.dir}/worker.env`,
                ...(target === "restored" ? ["--env-file", override] : []),
                "-v",
                `${credentials}:/credentials:ro`,
                "-v",
                `${target === "source" ? `${r.dir}/data` : dataDir}:/data`,
                "-v",
                `${folder}:/restore`,
                fixture.adminImage,
                ...args,
            ],
            true,
        );
        return { ...result, err: safe(result.err), out: safe(result.out) };
    };
    const requireSuccess = async (target: "source" | "restored", args: string[]) => {
        const result = await admin(target, args);
        assert.equal(result.code, 0, `${args[0]}: ${result.err}\n${result.out}`);
        return result.out;
    };
    const assertDokkuIdle = async () => {
        // Inspect the Dokku host, not the worker's SSH client. The Dokku fixture is exclusive
        // and deliberately has no jobs other than the two already settled deployments.
        assert.ok(
            dokkuIdle(await docker(["top", r.containers.dokku, "-eo", "pid,comm,args"], true)),
            "Could not verify that no Dokku operation is running on the fixture host.",
        );
    };
    const waitForRecovery = async (started: string) => {
        const timestamp = Date.parse(started);
        assert.ok(Number.isFinite(timestamp) && timestamp <= Date.now());
        const remaining = timestamp + RECOVERY_WAIT_MS - Date.now();
        console.log(`Recovery grace: waiting ${Math.ceil(Math.max(remaining, 0) / 1000)} seconds.`);
        if (remaining > 0) await sleep(remaining + 1000);
        await assertDokkuIdle();
        assert.ok(Date.now() - timestamp >= RECOVERY_WAIT_MS);
        return Date.now() - timestamp;
    };

    // All credential writes run as the same UID as the built images. Only stdin carries secrets.
    const putCredential = (
        name: "restore-database-url" | "router-token" | "router-epoch",
        value: string,
    ) =>
        docker(
            [
                "run",
                "--rm",
                "-i",
                "--network",
                "none",
                "-v",
                `${credentials}:/credentials`,
                "--entrypoint",
                "sh",
                r.images.worker,
                "-c",
                'umask 077; cat > "/credentials/$1.next" && mv "/credentials/$1.next" "/credentials/$1"',
                "sh",
                name,
            ],
            false,
            `${value}\n`,
        );

    return {
        dataDir,
        override,
        controller: fixture.controller,
        database: fixture.database,
        async snapshot() {
            await requireSuccess("source", ["backup", BACKUP]);
            await requireSuccess("source", ["verify-backup", BACKUP]);
        },
        async restore() {
            await docker(["stop", "--time", "30", r.containers.worker1]);
            await docker(["stop", "--time", "30", r.containers.controller]);
            for (const name of [r.containers.worker1, r.containers.controller]) {
                const state = await docker(["inspect", "-f", "{{.State.Status}}", name]);
                assert.equal(state.out, "exited", `${name} did not stop.`);
            }
            console.log("Writers stopped; waiting 301 seconds for the dispatch and lease bounds.");
            await sleep(WRITER_DRAIN_MS);
            await assertDokkuIdle();
            await docker([
                "exec",
                r.containers.postgres,
                "createdb",
                "-U",
                "launchpad",
                "--owner=launchpad",
                fixture.database,
            ]);
            await writeFile(override, `DATABASE_URL=${restored.href}\n`, { mode: 0o600 });
            await requireSuccess("restored", ["restore", BACKUP, "--i-have-stopped-the-workers"]);
            assert.match(
                await requireSuccess("restored", ["migrate", "--status"]),
                /^pending: 0$/m,
            );
            assert.match(
                await requireSuccess("restored", ["check-restore"]),
                /0 archive\(s\) missing; 0 of 2 deployment\(s\) have no app/,
            );
            const marker = await docker([
                "run",
                "--rm",
                "--network",
                "none",
                "-v",
                `${dataDir}:/data:ro`,
                "--entrypoint",
                "cat",
                fixture.adminImage,
                MARKER,
            ]);
            await docker([
                "run",
                "-d",
                "--name",
                fixture.controller,
                "--network",
                r.network,
                "--env-file",
                `${r.dir}/controller.env`,
                "--env-file",
                override,
                "-v",
                `${dataDir}:/data`,
                r.images.controller,
            ]);
            return JSON.parse(marker.out) as {
                restoreStartedAt: string;
                routerEpoch: string;
                routerEpochNote: string;
            };
        },
        async rotate() {
            await putCredential("restore-database-url", restored.href);
            const token = randomHex(32);
            await docker(["stop", "--time", "30", r.containers.router]);
            const result = await docker(
                [
                    "run",
                    "--rm",
                    "-i",
                    "--network",
                    r.network,
                    "-v",
                    `${stateVolume}:/state`,
                    "-v",
                    `${credentials}:/credentials:ro`,
                    ...routerEnv,
                    r.images.router,
                    "rotate",
                    "--token-stdin",
                    "--database-url-file",
                    "/credentials/restore-database-url",
                ],
                true,
                `${token}\n`,
            );
            assert.equal(result.code, 0, `Managed router rotation failed: ${safe(result.err)}`);
            const epoch = result.out;
            assert.match(epoch, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
            await putCredential("router-token", token);
            await putCredential("router-epoch", epoch);
            await docker(["start", r.containers.router]);
            await waitForRouter();
            return { epoch, token };
        },
        async raiseCounters() {
            assert.match(
                await requireSuccess("restored", ["recovery-raise-counters"]),
                /^Raised 1 alias counter\(s\)\.$/,
            );
        },
        async republish(aliasId: string) {
            await requireSuccess("restored", ["recovery-republish-alias", "--alias", aliasId]);
        },
        async requireEarlyRefusal(aliasId: string) {
            // Not a fabricated attestation: both checks attest only to fixture host settlement.
            await assertDokkuIdle();
            for (const args of [
                ["recovery-republish-alias", "--alias", aliasId],
                ["recovery-clear", "--i-have-checked-the-dokku-host"],
            ]) {
                const result = await admin("restored", args);
                assert.notEqual(result.code, 0, `${args[0]} unexpectedly passed before its wait.`);
                assert.match(
                    result.err,
                    /Wait at least 25 minutes from the recorded restore start/,
                );
            }
        },
        waitForRecovery,
        async clear() {
            await assertDokkuIdle();
            const out = await requireSuccess("restored", [
                "recovery-clear",
                "--i-have-checked-the-dokku-host",
            ]);
            assert.match(out, /Deployment recovery cleared after verification\./);
            await docker([
                "run",
                "--rm",
                "--network",
                "none",
                "-v",
                `${dataDir}:/data:ro`,
                "--entrypoint",
                "test",
                fixture.adminImage,
                "!",
                "-e",
                MARKER,
            ]);
        },
    };
}
