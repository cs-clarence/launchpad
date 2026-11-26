import { describe, expect, it } from "vitest";
import { nameFromHostname, workerNameFromEnv } from "./worker-id";

const host = () => "Build-Host.example.com";

describe("workerNameFromEnv", () => {
    it("prefers LAUNCHPAD_WORKER_NAME, then the deprecated LAUNCHPAD_WORKER_ID, then the hostname", () => {
        expect(
            workerNameFromEnv(
                { LAUNCHPAD_WORKER_NAME: "named", LAUNCHPAD_WORKER_ID: "legacy" },
                host,
            ),
        ).toEqual({ name: "named", deprecatedAlias: false });
        expect(workerNameFromEnv({ LAUNCHPAD_WORKER_ID: "legacy" }, host)).toEqual({
            name: "legacy",
            deprecatedAlias: true,
        });
        expect(workerNameFromEnv({}, host)).toEqual({
            name: "build-host.example.com",
            deprecatedAlias: false,
        });
    });

    it("treats blank values as unset", () => {
        expect(
            workerNameFromEnv({ LAUNCHPAD_WORKER_NAME: "  ", LAUNCHPAD_WORKER_ID: "" }, host).name,
        ).toBe("build-host.example.com");
        expect(
            workerNameFromEnv({ LAUNCHPAD_WORKER_NAME: "", LAUNCHPAD_WORKER_ID: "w1" }, host),
        ).toEqual({ name: "w1", deprecatedAlias: true });
    });

    it("returns a configured name unchanged and stable across restarts", () => {
        const env = { LAUNCHPAD_WORKER_NAME: "builder-1.eu_west" };
        expect(workerNameFromEnv(env, host).name).toBe("builder-1.eu_west");
        expect(workerNameFromEnv(env, host)).toEqual(workerNameFromEnv(env, host));
        expect(workerNameFromEnv({ LAUNCHPAD_WORKER_NAME: "  w1  " }, host).name).toBe("w1");
        expect(
            workerNameFromEnv({ LAUNCHPAD_WORKER_NAME: "a".repeat(64) }, host).name,
        ).toHaveLength(64);
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
    ])("refuses %j and names the variable", (value) => {
        expect(() => workerNameFromEnv({ LAUNCHPAD_WORKER_NAME: value }, host)).toThrow(
            "LAUNCHPAD_WORKER_NAME",
        );
        expect(() => workerNameFromEnv({ LAUNCHPAD_WORKER_ID: value }, host)).toThrow(
            "LAUNCHPAD_WORKER_ID",
        );
    });
});

describe("nameFromHostname", () => {
    it.each([
        ["launchpad-worker", "launchpad-worker"],
        ["Mixed.Case", "mixed.case"],
        ["a1b2c3d4e5f6", "a1b2c3d4e5f6"],
        ["host name!", "host-name-"],
        ["_.-host", "host"],
        ["---", "worker"],
        ["", "worker"],
        ["ünïcode", "n-code"],
        ["x".repeat(100), "x".repeat(64)],
    ])("%j becomes %j", (input, expected) => {
        expect(nameFromHostname(input)).toBe(expected);
    });
});
