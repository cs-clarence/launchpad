import { createDatabase } from "@launchpad/database";
import { createDokkuClient } from "@launchpad/dokku";
import { DEFAULT_ARTIFACT_LIMITS } from "@launchpad/services";
import { loadConfig } from "./config";
import { createDocker } from "./docker";
import { createDeployPorts } from "./ports";
import { runWorker } from "./worker";

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
    const db = createDatabase(config.databaseUrl, { max: 4 });
    const ports = createDeployPorts({
        dokku: createDokkuClient({ ...config.dokku }),
        docker: createDocker({ binary: config.dockerBinary }),
        dataDir: config.dataDir,
        limits: {
            maxExpandedBytes: DEFAULT_ARTIFACT_LIMITS.maxExpandedBytes,
            maxEntries: DEFAULT_ARTIFACT_LIMITS.maxEntries,
            maxDepth: DEFAULT_ARTIFACT_LIMITS.maxDepth,
        },
        baseImage: config.baseImage,
        probe: { proxyUrl: config.proxyUrl, timeoutMs: 90_000, intervalMs: 1500 },
    });
    log({ event: "started", worker: config.workerId });
    try {
        await runWorker(db, ports, {
            owner: config.workerId,
            deps: { enabled: true },
            leaseMs: config.leaseMs,
            pollMs: config.pollMs,
            signal: shutdown.signal,
            log,
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
