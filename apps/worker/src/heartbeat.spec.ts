import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeat, type HeartbeatStore } from "./heartbeat";

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

function setup(overrides: Partial<HeartbeatStore> = {}, options: { intervalMs?: number } = {}) {
    const calls: string[] = [];
    const log = vi.fn<(line: Record<string, unknown>) => void>();
    const store: HeartbeatStore = {
        start: vi.fn(async () => {
            calls.push("start");
            return { takenOver: false };
        }),
        beat: vi.fn(async () => {
            calls.push("beat");
            return true;
        }),
        stop: vi.fn(async () => {
            calls.push("stop");
        }),
        cleanup: vi.fn(async () => {
            calls.push("cleanup");
        }),
        ...overrides,
    };
    const heartbeat = createHeartbeat({ store, intervalMs: options.intervalMs ?? 15_000, log });
    return { heartbeat, store, calls, log };
}

describe("worker heartbeat", () => {
    it("starts the row, cleans up, then beats at the interval", async () => {
        const { heartbeat, calls } = setup();
        heartbeat.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toEqual(["start", "cleanup"]);
        await vi.advanceTimersByTimeAsync(15_000);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(calls).toEqual(["start", "cleanup", "beat", "beat"]);
        await heartbeat.stop();
    });

    it("cleans up again once an hour", async () => {
        const { heartbeat, store } = setup();
        heartbeat.start();
        await vi.advanceTimersByTimeAsync(3_600_000 + 15_000);
        expect(vi.mocked(store.cleanup).mock.calls.length).toBe(2);
        await heartbeat.stop();
    });

    it("never overlaps beats: a beat that outlasts its deadline is followed by exactly one next beat", async () => {
        let inFlight = 0;
        let peak = 0;
        let total = 0;
        const { heartbeat } = setup({
            beat: async () => {
                total++;
                peak = Math.max(peak, ++inFlight);
                await new Promise((resolve) => setTimeout(resolve, 20_000));
                inFlight--;
                return true;
            },
        });
        heartbeat.start();
        await vi.advanceTimersByTimeAsync(0);
        // First beat after 15 s; it takes 20 s but is abandoned at 5 s, the next one 15 s later.
        await vi.advanceTimersByTimeAsync(15_000 + 5_000);
        expect(total).toBe(1);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(total).toBe(2);
        void heartbeat.stop();
    });

    it("uses the interval as the deadline when it is shorter than 5 s", async () => {
        const { heartbeat, log } = setup(
            { start: () => new Promise(() => {}) },
            { intervalMs: 2_000 },
        );
        heartbeat.start();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(log).toHaveBeenCalledWith(
            expect.objectContaining({ event: "worker-heartbeat-error" }),
        );
        void heartbeat.stop();
    });

    it("never throws or stops the loop when the store fails, and logs once per outage", async () => {
        let failing = true;
        const { heartbeat, calls, log } = setup({
            beat: async () => {
                calls.push("beat");
                if (failing) throw new Error("password=hunter2 at 10.0.0.5");
                return true;
            },
        });
        heartbeat.start();
        await vi.advanceTimersByTimeAsync(15_000 * 4);
        expect(calls.filter((c) => c === "beat")).toHaveLength(4);
        const errors = log.mock.calls.filter(([line]) => line.event === "worker-heartbeat-error");
        expect(errors).toHaveLength(1);
        expect(JSON.stringify(log.mock.calls)).not.toContain("hunter2");
        failing = false;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(log).toHaveBeenCalledWith({ event: "worker-heartbeat-recovered" });
        await heartbeat.stop();
    });

    it("keeps trying to start when the first start fails (a database not yet migrated)", async () => {
        const start = vi
            .fn<HeartbeatStore["start"]>()
            .mockRejectedValueOnce(new Error("relation does not exist"))
            .mockResolvedValue({ takenOver: false });
        const { heartbeat, store } = setup({ start });
        heartbeat.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(store.beat).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(start).toHaveBeenCalledTimes(2);
        await heartbeat.stop();
    });

    it("re-inserts a lost row and logs worker-name-in-use", async () => {
        const beat = vi
            .fn<HeartbeatStore["beat"]>()
            .mockResolvedValueOnce(false)
            .mockResolvedValue(true);
        const { heartbeat, store, log } = setup({ beat });
        heartbeat.start();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(store.start).toHaveBeenCalledTimes(2);
        expect(log).toHaveBeenCalledWith({ event: "worker-name-in-use" });
        await heartbeat.stop();
    });

    it("logs worker-name-in-use when the start finds another live run of the name", async () => {
        const { heartbeat, log } = setup({ start: async () => ({ takenOver: true }) });
        heartbeat.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(log).toHaveBeenCalledWith({ event: "worker-name-in-use" });
        await heartbeat.stop();
    });

    describe("clean stop", () => {
        it("writes the stop mark once and no beat follows it", async () => {
            const { heartbeat, calls } = setup();
            heartbeat.start();
            await vi.advanceTimersByTimeAsync(15_000);
            await heartbeat.stop();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(calls.at(-1)).toBe("stop");
            expect(calls.filter((c) => c === "stop")).toHaveLength(1);
        });

        it("waits for a beat in flight before the mark", async () => {
            let finish: (value: boolean) => void = () => {};
            const { heartbeat, calls } = setup({
                beat: () =>
                    new Promise<boolean>((resolve) => {
                        calls.push("beat");
                        finish = resolve;
                    }),
            });
            heartbeat.start();
            await vi.advanceTimersByTimeAsync(15_000);
            const stopped = heartbeat.stop();
            await vi.advanceTimersByTimeAsync(500);
            expect(calls).not.toContain("stop");
            finish(true);
            await stopped;
            expect(calls.at(-1)).toBe("stop");
        });

        it("ends at 2 s when the store hangs, and tolerates failure", async () => {
            const { heartbeat, log } = setup({ stop: () => new Promise(() => {}) });
            heartbeat.start();
            await vi.advanceTimersByTimeAsync(0);
            let done = false;
            void heartbeat.stop().then(() => (done = true));
            await vi.advanceTimersByTimeAsync(1_999);
            expect(done).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(done).toBe(true);
            expect(log).toHaveBeenCalledWith(
                expect.objectContaining({ event: "worker-heartbeat-stop-failed" }),
            );
        });

        it("is independent of an aborted shutdown signal and never throws on failure", async () => {
            const controller = new AbortController();
            controller.abort();
            const { heartbeat } = setup({
                stop: async () => {
                    throw new Error("down");
                },
            });
            heartbeat.start();
            await vi.advanceTimersByTimeAsync(0);
            await expect(heartbeat.stop()).resolves.toBeUndefined();
        });

        it("writes no mark when the row was never started", async () => {
            const { heartbeat, store } = setup({
                start: async () => {
                    throw new Error("no table");
                },
            });
            heartbeat.start();
            await vi.advanceTimersByTimeAsync(0);
            await heartbeat.stop();
            expect(store.stop).not.toHaveBeenCalled();
        });
    });
});
