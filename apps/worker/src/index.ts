import { randomUUID } from "node:crypto";
import path from "node:path";
import { createDatabase } from "@launchpad-kit/database";
import { createDokkuClient } from "@launchpad-kit/dokku";
import {
    artifactLimitsFromEnv,
    parseDeploymentConfig,
    resolveLimits,
} from "@launchpad-kit/services";
import { workDeployments } from "./deployment-worker";
import { createDocker } from "./docker";
import { DEFAULT_HEALTH_TOUCH_MS, createHealthMarker, healthFileFromEnv } from "./health";
import { createDeployPorts } from "./ports";
import { DEFAULT_BASE_IMAGE, checkBaseImage } from "./template";
import { parseProxyUrl } from "./verify";

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
        const databaseUrl = required("DATABASE_URL");
        const dataDir = path.resolve(required("LAUNCHPAD_DATA_DIR"));
        const baseImage = checkBaseImage(process.env.LAUNCHPAD_BASE_IMAGE || DEFAULT_BASE_IMAGE);
        const ports = createDeployPorts({
            dokku: createDokkuClient({
                host: required("DOKKU_SSH_HOST"),
                port: Number(process.env.DOKKU_SSH_PORT || 22),
                username: process.env.DOKKU_SSH_USER || "dokku",
                privateKeyPath: required("DOKKU_SSH_KEY_PATH"),
                knownHostsPath: required("DOKKU_SSH_KNOWN_HOSTS_PATH"),
            }),
            docker: createDocker(),
            dataDir,
            limits: resolveLimits(artifactLimitsFromEnv(process.env)),
            baseImage,
            probe: {
                proxyUrl: parseProxyUrl(required("LAUNCHPAD_APPS_PROXY_URL")),
                timeoutMs: 120_000,
                intervalMs: 2000,
            },
        });
        const db = createDatabase(databaseUrl, {
            max: 2,
            connectionTimeout: 5,
            closeTimeout: 0,
            connection: { statement_timeout: "5s", idle_in_transaction_session_timeout: "10s" },
        });
        try {
            log({ event: "deployment-worker-started" });
            await workDeployments({
                db,
                dataDir,
                owner: randomUUID(),
                ports,
                shutdown: shutdown.signal,
                markHealthy,
                log,
            });
        } finally {
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
