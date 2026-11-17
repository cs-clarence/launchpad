import { afterEach, describe, expect, it, vi } from "vitest";
import { startDeadline } from "./deadline";

afterEach(() => vi.restoreAllMocks());

describe("a lease deadline", () => {
    it("is not passed before its time and passed after, by the monotonic timer", () => {
        let mono = 1000;
        vi.spyOn(performance, "now").mockImplementation(() => mono);
        const deadline = startDeadline(500);
        expect(deadline.passed()).toBe(false);
        expect(deadline.remainingMs()).toBe(500);
        mono = 1499;
        expect(deadline.passed()).toBe(false);
        mono = 1500;
        expect(deadline.passed()).toBe(true);
    });

    it("is passed when the wall clock says so even if the monotonic timer stood still (a suspended machine)", () => {
        vi.spyOn(performance, "now").mockImplementation(() => 1000);
        let wall = 50_000;
        vi.spyOn(Date, "now").mockImplementation(() => wall);
        const deadline = startDeadline(500);
        expect(deadline.passed()).toBe(false);
        // The machine slept for an hour: the timer did not advance, the wall clock did.
        wall += 3_600_000;
        expect(deadline.passed()).toBe(true);
    });

    it("is not passed early when the wall clock is put back", () => {
        let mono = 1000;
        vi.spyOn(performance, "now").mockImplementation(() => mono);
        let wall = 50_000;
        vi.spyOn(Date, "now").mockImplementation(() => wall);
        const deadline = startDeadline(500);
        wall -= 3_600_000;
        mono = 1200;
        expect(deadline.passed()).toBe(false);
    });

    it("gives a signal that aborts when the wall clock says so after a suspend, and when the timer runs out", async () => {
        vi.useFakeTimers();
        try {
            let mono = 1000;
            vi.spyOn(performance, "now").mockImplementation(() => mono);
            let wall = 50_000;
            vi.spyOn(Date, "now").mockImplementation(() => wall);
            const deadline = startDeadline(5000);
            const signal = deadline.signal();
            expect(signal.aborted).toBe(false);
            // The machine slept for an hour: the monotonic timer stood still, the wall clock did not.
            wall += 3_600_000;
            await vi.advanceTimersByTimeAsync(1000);
            expect(signal.aborted).toBe(true);
            expect((signal.reason as DOMException).name).toBe("TimeoutError");
            // And an ordinary timeout aborts it too.
            wall = 50_000;
            const plain = startDeadline(2000).signal();
            await vi.advanceTimersByTimeAsync(2100);
            expect(plain.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not abort early, and stops watching once it has", async () => {
        vi.useFakeTimers();
        try {
            const signal = startDeadline(3000).signal();
            await vi.advanceTimersByTimeAsync(2000);
            expect(signal.aborted).toBe(false);
            await vi.advanceTimersByTimeAsync(1500);
            expect(signal.aborted).toBe(true);
            // Nothing is left running.
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("stops watching on request, for every signal it gave out, and nothing is left running", async () => {
        vi.useFakeTimers();
        try {
            const deadline = startDeadline(600_000);
            const a = deadline.signal();
            const b = deadline.signal();
            expect(vi.getTimerCount()).toBe(4);
            deadline.stop();
            // The work is done well before the lease: no timer or poll remains.
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(700_000);
            expect(a.aborted).toBe(false);
            expect(b.aborted).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
