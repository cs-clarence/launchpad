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
});
