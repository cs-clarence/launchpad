import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHealthMarker, healthFileFromEnv } from "./health";

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "launchpad-health-"));
    dirs.push(dir);
    return dir;
};

describe("createHealthMarker", () => {
    it("creates the file, then moves its modification time forward", () => {
        const file = path.join(temp(), "healthy");
        const mark = createHealthMarker(file);
        mark();
        expect(statSync(file).isFile()).toBe(true);
        utimesSync(file, new Date(1000), new Date(1000));
        mark();
        expect(statSync(file).mtimeMs).toBeGreaterThan(Date.now() - 5000);
    });

    it("does nothing without a file, and never throws when the file cannot be written", () => {
        expect(() => createHealthMarker(undefined)()).not.toThrow();
        expect(() =>
            createHealthMarker(path.join(temp(), "missing", "dir", "healthy"))(),
        ).not.toThrow();
    });
});

describe("healthFileFromEnv", () => {
    it("is off when unset and refuses a relative or traversing path", () => {
        expect(healthFileFromEnv({})).toBeUndefined();
        expect(healthFileFromEnv({ LAUNCHPAD_WORKER_HEALTH_FILE: "" })).toBeUndefined();
        expect(healthFileFromEnv({ LAUNCHPAD_WORKER_HEALTH_FILE: "/tmp/healthy" })).toBe(
            "/tmp/healthy",
        );
        expect(() => healthFileFromEnv({ LAUNCHPAD_WORKER_HEALTH_FILE: "healthy" })).toThrow(
            "absolute",
        );
        expect(() =>
            healthFileFromEnv({ LAUNCHPAD_WORKER_HEALTH_FILE: "/tmp/../healthy" }),
        ).toThrow("absolute");
    });
});
