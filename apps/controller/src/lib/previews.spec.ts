import { describe, expect, it } from "vitest";
import { isInProgress, mergeEvents, statusLabel } from "./previews";

const event = (seq: number) => ({
    seq,
    phase: "build",
    level: "info",
    message: `m${seq}`,
    createdAt: "2026-01-01T00:00:00.000Z",
});

describe("preview progress", () => {
    it("polls only while a deployment is moving", () => {
        for (const s of ["queued", "preparing", "building", "deploying", "verifying"]) {
            expect(isInProgress(s)).toBe(true);
        }
        for (const s of ["succeeded", "failed", "cancelled", "reconciliation-needed", "x"]) {
            expect(isInProgress(s)).toBe(false);
        }
    });

    it("labels every status, and passes an unknown one through", () => {
        expect(statusLabel("succeeded")).toBe("Live");
        expect(statusLabel("reconciliation-needed")).toBe("Needs an administrator");
        expect(statusLabel("future")).toBe("future");
    });

    it("merges events in order without repeating any", () => {
        const first = mergeEvents([], [event(2), event(1)]);
        expect(first.events.map((e) => e.seq)).toEqual([1, 2]);
        expect(first.after).toBe(2);
        const next = mergeEvents(first.events, [event(2), event(3)]);
        expect(next.events.map((e) => e.seq)).toEqual([1, 2, 3]);
        expect(next.after).toBe(3);
        expect(mergeEvents([], []).after).toBe(0);
    });
});
