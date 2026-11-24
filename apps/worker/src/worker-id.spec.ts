import { describe, expect, it } from "vitest";
import { workerIdFromEnv } from "./worker-id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("workerIdFromEnv", () => {
    it("uses a new random identity per call when the setting is unset or blank", () => {
        const first = workerIdFromEnv({});
        expect(first).toMatch(UUID);
        expect(workerIdFromEnv({ LAUNCHPAD_WORKER_ID: "" })).toMatch(UUID);
        expect(workerIdFromEnv({ LAUNCHPAD_WORKER_ID: "  \t" })).toMatch(UUID);
        expect(workerIdFromEnv({})).not.toBe(first);
    });

    it("returns a configured name unchanged, so it stays the same across restarts", () => {
        const env = { LAUNCHPAD_WORKER_ID: "builder-1.eu_west" };
        expect(workerIdFromEnv(env)).toBe("builder-1.eu_west");
        expect(workerIdFromEnv(env)).toBe(workerIdFromEnv(env));
        expect(workerIdFromEnv({ LAUNCHPAD_WORKER_ID: "  w1  " })).toBe("w1");
        expect(workerIdFromEnv({ LAUNCHPAD_WORKER_ID: "a".repeat(64) })).toHaveLength(64);
    });

    it.each([
        "a".repeat(65),
        "-leading",
        ".leading",
        "has space",
        "has/slash",
        "line\nbreak",
        "émoji",
        "semi;colon",
    ])("refuses %j", (value) => {
        expect(() => workerIdFromEnv({ LAUNCHPAD_WORKER_ID: value })).toThrow(
            "LAUNCHPAD_WORKER_ID",
        );
    });
});
