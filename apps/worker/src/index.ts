import { assertSchemaCurrent, createDatabase } from "@launchpad/database";
import { createDokkuClient } from "@launchpad/dokku";
import { recoverInterruptedCollections } from "@launchpad/services";
import { sweepScratch } from "./build";
import { loadConfig } from "./config";
import { createDocker } from "./docker";
import { createLifecyclePorts } from "./lifecycle-ports";
import { createDeployPorts } from "./ports";
import { runWorker } from "./worker";

// Shown to the operator next to each worker; the package version is the release.
const WORKER_VERSION = (
    process.env.LAUNCHPAD_VERSION ||
    process.env.npm_package_version ||
    "unknown"
).slice(0, 64);

const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));

async function main() {
    const loaded = loadConfig(process.env);
    const shutdown = new AbortController();
    for (const name of ["SIGINT", "SIGTERM"] as const) {
        process.on(name, () => shutdown.abort());
    }
    if (!loaded.enabled) {
        // Idle rather than exit, so a supervisor does not restart it in a loop.
        log({ event: "disabled", message: "LAUNCHPAD_DEPLOYMENTS is off; the worker is idle." });
        await new Promise<void>((resolve) =>
            shutdown.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return;
    }
    const { config } = loaded;
    // A worker killed mid-build leaves its scratch directory behind.
    await sweepScratch(config.dataDir);
    const db = createDatabase(config.databaseUrl, { max: 4 });
    // Refuse a schema this build was not made for, before anything reads or writes.
    await assertSchemaCurrent(db);
    // A collection that died between moving an archive aside and committing leaves a live
    // artifact without its file: put it back before any deployment can read it.
    const recovered = await recoverInterruptedCollections(db, { dataDir: config.dataDir });
    if (recovered.restored > 0) log({ event: "recovered-archives", restored: recovered.restored });
    const dokku = createDokkuClient({ ...config.dokku });
    const docker = createDocker({ binary: config.dockerBinary });
    const ports = createDeployPorts({
        dokku,
        docker,
        dataDir: config.dataDir,
        limits: config.archiveLimits,
        baseImage: config.baseImage,
        probe: { proxyUrl: config.proxyUrl, timeoutMs: 90_000, intervalMs: 1500 },
    });
    log({ event: "started", worker: config.workerId, lifecycle: config.lifecycle.enabled });
    try {
        await runWorker(db, ports, {
            owner: config.workerId,
            deps: { enabled: true },
            leaseMs: config.leaseMs,
            pollMs: config.pollMs,
            signal: shutdown.signal,
            log,
            heartbeat: { version: WORKER_VERSION },
            lifecycle: {
                ports: createLifecyclePorts({ dokku, docker }),
                config: config.lifecycle,
                dataDir: config.dataDir,
            },
        });
    } finally {
        await db.destroy();
    }
    log({ event: "stopped" });
}

main().catch((error: unknown) => {
    // Configuration errors are safe to show; they never contain secret values.
    console.error(error instanceof Error ? error.message : "The worker failed to start.");
    process.exit(1);
});
