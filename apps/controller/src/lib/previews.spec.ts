import { describe, expect, it } from "vitest";
import {
    deletionLabel,
    deletionNeedsPerson,
    describeExpiry,
    extendChoices,
    isDeletionInProgress,
    isInProgress,
    mergeEvents,
    statusLabel,
} from "./previews";
import { createClock } from "./use-now";

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

describe("preview lifetimes", () => {
    const NOW = Date.parse("2026-11-17T00:00:00.000Z");
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    it("describes when a preview goes, for people", () => {
        const active = (expiresAt: string | null) => ({ state: "active", expiresAt });
        expect(describeExpiry(active(null), NOW)).toBe("Never expires");
        expect(describeExpiry(active(at(30 * 60_000)), NOW)).toBe("Expires in 30 minutes");
        expect(describeExpiry(active(at(60_000)), NOW)).toBe("Expires in 1 minute");
        expect(describeExpiry(active(at(59_999)), NOW)).toBe("Expires in less than a minute");
        // Where this controller does not run the lifecycle, how soon it goes is not known.
        expect(describeExpiry(active(at(-1)), NOW, false)).toBe("Past its expiry");
        expect(describeExpiry(active(at(47 * 3_600_000 + 59 * 60_000)), NOW)).toBe(
            "Expires in 47 hours",
        );
        expect(describeExpiry(active(at(48 * 3_600_000)), NOW)).toBe("Expires in 2 days");
        expect(describeExpiry(active(at(5 * 3_600_000 + 59 * 60_000)), NOW)).toBe(
            "Expires in 5 hours",
        );
        expect(describeExpiry(active(at(3 * 86_400_000 + 3_600_000)), NOW)).toBe(
            "Expires in 3 days",
        );
        expect(describeExpiry(active(at(-1)), NOW)).toBe("Expired, will be deleted shortly");
        expect(describeExpiry(active("nonsense"), NOW)).toBe("Unknown");
        expect(describeExpiry({ state: "deleting", expiresAt: at(1000) }, NOW)).toBe(
            "Being deleted",
        );
        expect(describeExpiry({ state: "deleted", expiresAt: null }, NOW)).toBe("Deleted");
        expect(
            describeExpiry(active(new Date(NOW + 2 * 3_600_000) as unknown as string), NOW),
        ).toBe("Expires in 2 hours");
    });

    it("tells a deletion in progress from one that needs a person", () => {
        expect(deletionLabel("reconciliation-needed")).toBe("Needs an administrator");
        expect(deletionLabel("future")).toBe("future");
        expect(deletionNeedsPerson("reconciliation-needed")).toBe(true);
        for (const s of ["queued", "running", "succeeded"])
            expect(deletionNeedsPerson(s)).toBe(false);
        expect(isDeletionInProgress("queued")).toBe(true);
        expect(isDeletionInProgress("running")).toBe(true);
        expect(isDeletionInProgress("succeeded")).toBe(false);
        expect(isDeletionInProgress("reconciliation-needed")).toBe(false);
    });
});

describe("extend choices", () => {
    it("offers only what the server accepts, defaulting to at most a week", () => {
        expect(extendChoices(30 * 86_400)).toEqual({
            choices: ["24h", "3d", "7d", "14d"],
            initial: "7d",
        });
        expect(extendChoices(5 * 86_400)).toEqual({ choices: ["24h", "3d"], initial: "3d" });
        expect(extendChoices(86_400).initial).toBe("24h");
        expect(extendChoices(7_200)).toEqual({ choices: ["7200s"], initial: "7200s" });
    });
});

describe("the page clock", () => {
    it("moves on from the server's time by what a monotonic timer has advanced", () => {
        let timer = 50_000;
        const clock = createClock(1_000, () => timer);
        expect(clock()).toBe(1_000);
        timer = 80_000;
        expect(clock()).toBe(31_000);
    });

    it("ignores the wall clock, so a correction of it cannot move the time backwards", () => {
        let timer = 5_000;
        const clock = createClock(1_000, () => timer);
        const realNow = Date.now;
        try {
            timer = 35_000;
            expect(clock()).toBe(31_000);
            // The browser's clock is put back an hour.
            Date.now = () => realNow() - 3_600_000;
            timer = 65_000;
            expect(clock()).toBe(61_000);
        } finally {
            Date.now = realNow;
        }
    });
});
