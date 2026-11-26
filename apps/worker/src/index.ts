import { randomUUID } from "node:crypto";
import path from "node:path";
import { createDatabase } from "@launchpad-kit/database";
import { createDokkuClient } from "@launchpad-kit/dokku";
import {
    artifactLimitsFromEnv,
    parseAliasConfig,
    parseAppRoutingConfig,
    beatHeartbeat,
    parseDeploymentConfig,
    parseHeartbeatConfig,
    pruneHeartbeats,
    resolveLimits,
    startHeartbeat,
    stopHeartbeat,
} from "@launchpad-kit/services";
import { workDeployments } from "./deployment-worker";
import { createHeartbeat } from "./heartbeat";
import { createDocker } from "./docker";
import { DEFAULT_HEALTH_TOUCH_MS, createHealthMarker, healthFileFromEnv } from "./health";
import { createLifecyclePorts } from "./lifecycle-ports";
import { createPromotionPorts } from "./promotion-ports";
import { createDeployPorts } from "./ports";
import { DEFAULT_BASE_IMAGE, checkBaseImage } from "./template";
import { parseProxyUrl } from "./verify";
import { workerNameFromEnv } from "./worker-id";

const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));

function required(name: string) {
    const value = process.env[name];
    if (!value?.trim()) throw new Error(`${name} is required when deployments are on.`);
    return value;
}

async function main() {
    const config = parseDeploymentConfig(process.env);
    const markHealthy = createHealthMarker(healthFileFromEnv(process.env));
    const shutdown = new AbortController();
    for (const name of ["SIGINT", "SIGTERM"] as const) {
        process.on(name, () => shutdown.abort());
    }
    if (config.enabled) {
        // The stable name is the lease owner and the heartbeat's key; the run id tells restarts apart.
        const { name: owner, deprecatedAlias } = workerNameFromEnv(process.env);
        const runId = randomUUID();
        const heartbeatConfig = parseHeartbeatConfig(process.env, "worker");
        const databaseUrl = required("DATABASE_URL");
        const dataDir = path.resolve(required("LAUNCHPAD_DATA_DIR"));
        const baseImage = checkBaseImage(process.env.LAUNCHPAD_BASE_IMAGE || DEFAULT_BASE_IMAGE);
        const dokku = createDokkuClient({
            host: required("DOKKU_SSH_HOST"),
            port: Number(process.env.DOKKU_SSH_PORT || 22),
            username: process.env.DOKKU_SSH_USER || "dokku",
            privateKeyPath: required("DOKKU_SSH_KEY_PATH"),
            knownHostsPath: required("DOKKU_SSH_KNOWN_HOSTS_PATH"),
        });
        const docker = createDocker();
        const deletionPorts = createLifecyclePorts({ dokku, docker });
        const ports = createDeployPorts({
            dokku,
            docker,
            dataDir,
            limits: resolveLimits(artifactLimitsFromEnv(process.env)),
            baseImage,
            probe: {
                proxyUrl: parseProxyUrl(required("LAUNCHPAD_APPS_PROXY_URL")),
                timeoutMs: 120_000,
                intervalMs: 2000,
            },
        });
        // Aliases are switched separately. With them off the worker never reads router settings
        // and never contacts the router; with them on every router setting must be valid.
        let promotionPorts: ReturnType<typeof createPromotionPorts> | undefined;
        if (parseAliasConfig(process.env).enabled) {
            const routing = parseAppRoutingConfig(process.env);
            if (!routing.enabled)
                throw new Error("Router settings are required when aliases are on.");
            promotionPorts = createPromotionPorts({ settings: routing });
        }
        const db = createDatabase(databaseUrl, {
            max: 2,
            connectionTimeout: 5,
            closeTimeout: 0,
            connection: { statement_timeout: "5s", idle_in_transaction_session_timeout: "10s" },
        });
        const identity = { name: owner, runId, beatSeconds: heartbeatConfig.beatSeconds };
        const heartbeat = createHeartbeat({
            intervalMs: heartbeatConfig.beatSeconds * 1000,
            log,
            store: {
                start: () => startHeartbeat(db, identity, heartbeatConfig.staleAfterSeconds),
                beat: () => beatHeartbeat(db, identity),
                stop: () => stopHeartbeat(db, identity),
                cleanup: async () => {
                    await pruneHeartbeats(db, heartbeatConfig.pruneAfterSeconds);
                },
            },
        });
        try {
            log({ event: "deployment-worker-started", worker: owner, runId });
            if (deprecatedAlias) {
                log({
                    event: "worker-name-deprecated",
                    message: "LAUNCHPAD_WORKER_ID is deprecated; use LAUNCHPAD_WORKER_NAME.",
                });
            }
            heartbeat.start();
            await workDeployments({
                db,
                dataDir,
                owner,
                ports,
                deletionPorts,
                promotionPorts,
                shutdown: shutdown.signal,
                markHealthy,
                log,
            });
        } finally {
            // After the work loop returns or throws, before the pool closes: a clean stop is
            // marked, and a hung database costs at most the heartbeat's own short budget.
            await heartbeat.stop();
            await db.destroy();
        }
        log({ event: "stopped" });
        return;
    }
    log({ event: "deployment-worker-idle" });
    // A pending promise does not keep the process alive on its own (Bun exits): a timer does, and
    // ends with the shutdown signal. Idle is a healthy state, not a stuck one.
    markHealthy();
    const keepAlive = setInterval(markHealthy, DEFAULT_HEALTH_TOUCH_MS);
    await new Promise<void>((resolve) =>
        shutdown.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    clearInterval(keepAlive);
    log({ event: "stopped" });
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "The worker failed to start.");
    process.exit(1);
});
