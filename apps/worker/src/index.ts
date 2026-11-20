import { assertNoRemovedSettings } from "@launchpad-kit/services/removed-settings";
import { DEFAULT_HEALTH_TOUCH_MS, createHealthMarker, healthFileFromEnv } from "./health";

const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));

// The preview deployment runtime was removed: previews were replaced by the immutable model,
// whose worker arrives later. Until then this process does nothing but stay up and healthy, so a
// supervisor does not restart it in a loop. It opens no database and needs no Dokku settings.
async function main() {
    assertNoRemovedSettings(process.env);
    const markHealthy = createHealthMarker(healthFileFromEnv(process.env));
    const shutdown = new AbortController();
    for (const name of ["SIGINT", "SIGTERM"] as const) {
        process.on(name, () => shutdown.abort());
    }
    log({
        event: "legacy-runtime-removed",
        message:
            "Preview deployments were removed; the worker is idle until the app model arrives.",
    });
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
