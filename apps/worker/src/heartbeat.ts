// The worker's heartbeat: one row per worker name that says "this process is alive". It is a
// loop of its own, not part of the claim loop, so a long deployment never stops it and a wedged
// event loop or paused container does. It never throws, never aborts the worker and never
// touches the health marker (that file keeps its meaning: queries work).

export interface HeartbeatStore {
    // Records a new run of this name (updates the row in place).
    start(): Promise<{ takenOver: boolean }>;
    // Refreshes this run's row; false when the row is gone or belongs to another run.
    beat(): Promise<boolean>;
    // Marks a clean stop.
    stop(): Promise<void>;
    cleanup(): Promise<void>;
}

export interface HeartbeatOptions {
    store: HeartbeatStore;
    intervalMs: number;
    log: (line: Record<string, unknown>) => void;
    // The deadline of one statement is the smaller of this and the interval.
    statementDeadlineMs?: number;
    // The whole clean stop (waiting for an in-flight beat and writing the mark) fits in this.
    stopDeadlineMs?: number;
    cleanupEveryMs?: number;
}

const HOUR_MS = 3_600_000;

class Timeout extends Error {}

function within<T>(run: () => Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        run(),
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Timeout()), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

export function createHeartbeat(options: HeartbeatOptions) {
    const { store, intervalMs, log } = options;
    const statementMs = Math.min(options.statementDeadlineMs ?? 5000, intervalMs);
    const stopMs = options.stopDeadlineMs ?? 2000;
    const cleanupEveryMs = options.cleanupEveryMs ?? HOUR_MS;
    let stopping = false;
    let started = false;
    let failing = false;
    let nameInUse = false;
    let okBeats = 0;
    let loop: Promise<void> | undefined;
    let wake: (() => void) | undefined;

    function failed(event: string) {
        // One line per outage, with a fixed message: error text can carry addresses or secrets.
        if (!failing) log({ event, message: "The worker heartbeat could not be written." });
        failing = true;
    }

    function recovered() {
        if (failing) log({ event: "worker-heartbeat-recovered" });
        failing = false;
    }

    async function pause(ms: number) {
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            wake = () => {
                clearTimeout(timer);
                resolve();
            };
        });
        wake = undefined;
    }

    async function begin() {
        const result = await within(() => store.start(), statementMs);
        started = true;
        recovered();
        if (result.takenOver) log({ event: "worker-name-in-use" });
    }

    // The statement behind a deadline is abandoned, not cancelled: it is bounded by the pool's
    // statement_timeout and the small pool, and the loop never starts the next beat before this one ends.
    async function once() {
        try {
            if (!started) {
                await begin();
                return;
            }
            if (!(await within(() => store.beat(), statementMs))) {
                // Taken over by another run of the same name, or pruned: claim the row again.
                started = false;
                okBeats = 0;
                await begin();
                if (!nameInUse) log({ event: "worker-name-in-use" });
                nameInUse = true;
                return;
            }
            // A takeover episode ends after a few clean beats in a row.
            if (nameInUse && ++okBeats >= 3) nameInUse = false;
            recovered();
        } catch {
            failed("worker-heartbeat-error");
        }
    }

    async function cleanup() {
        try {
            await within(() => store.cleanup(), statementMs);
        } catch {
            // Pruning is housekeeping: try again next hour.
        }
    }

    async function run() {
        let lastPrune = -Infinity;
        while (!stopping) {
            const began = Date.now();
            await once();
            if (started && began - lastPrune >= cleanupEveryMs) {
                lastPrune = began;
                await cleanup();
            }
            if (stopping) break;
            await pause(Math.max(0, intervalMs - (Date.now() - began)));
        }
    }

    return {
        // Starts the loop and returns at once.
        start() {
            loop ??= run();
        },
        // Stops the loop, waits for a beat in flight (a late one would clear the stop mark) and
        // marks a clean stop, all within one short budget. Never throws.
        async stop() {
            if (stopping) return;
            stopping = true;
            wake?.();
            try {
                await within(async () => {
                    await loop;
                    if (started) await store.stop();
                }, stopMs);
            } catch (error) {
                log({
                    event: "worker-heartbeat-stop-failed",
                    message:
                        error instanceof Timeout
                            ? "The stop mark timed out."
                            : "The stop mark was not written.",
                });
            }
        },
    };
}
