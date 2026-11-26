import { describe, expect, it } from "vitest";
import { parseSchemaCheckConfig } from "./controller-config";

const parse = (env: Record<string, string>) => parseSchemaCheckConfig(env);

describe("LAUNCHPAD_SCHEMA_CHECK_INTERVAL", () => {
    it("defaults to 10 s, also when empty", () => {
        expect(parse({}).intervalMs).toBe(10_000);
        expect(parse({ LAUNCHPAD_SCHEMA_CHECK_INTERVAL: "" }).intervalMs).toBe(10_000);
    });

    it.each([
        ["5s", 5_000],
        ["1m", 60_000],
        ["5m", 300_000],
        ["300s", 300_000],
    ])("accepts %s", (value, ms) => {
        expect(parse({ LAUNCHPAD_SCHEMA_CHECK_INTERVAL: value }).intervalMs).toBe(ms);
    });

    it.each(["off", "OFF", "0"])("%s means a pass is final", (value) => {
        expect(parse({ LAUNCHPAD_SCHEMA_CHECK_INTERVAL: value }).intervalMs).toBeNull();
    });

    it.each(["0s", "-5s", "301s", "6m", "1h", "10", "ten", "1.5s", "5 s"])(
        "refuses %s",
        (value) => {
            expect(() => parse({ LAUNCHPAD_SCHEMA_CHECK_INTERVAL: value })).toThrow(
                'LAUNCHPAD_SCHEMA_CHECK_INTERVAL must be a duration from 1s to 5m, or "off".',
            );
        },
    );
});

describe("LAUNCHPAD_SCHEMA_CHECK_TIMEOUT", () => {
    it("defaults to 4 s", () => {
        expect(parse({}).timeoutMs).toBe(4000);
    });

    it("accepts 1 s and 30 s and refuses 0 s and 31 s", () => {
        const env = { LAUNCHPAD_SCHEMA_CHECK_INTERVAL: "off" };
        expect(parse({ ...env, LAUNCHPAD_SCHEMA_CHECK_TIMEOUT: "1s" }).timeoutMs).toBe(1000);
        expect(parse({ ...env, LAUNCHPAD_SCHEMA_CHECK_TIMEOUT: "30s" }).timeoutMs).toBe(30_000);
        for (const value of ["0s", "31s", "0", "fast"]) {
            expect(() => parse({ ...env, LAUNCHPAD_SCHEMA_CHECK_TIMEOUT: value })).toThrow(
                "LAUNCHPAD_SCHEMA_CHECK_TIMEOUT must be a duration from 1s to 30s.",
            );
        }
    });

    it("must be shorter than the interval: refused at equal, accepted one second less", () => {
        const at = (interval: string, timeout: string) =>
            parse({
                LAUNCHPAD_SCHEMA_CHECK_INTERVAL: interval,
                LAUNCHPAD_SCHEMA_CHECK_TIMEOUT: timeout,
            });
        expect(() => at("10s", "10s")).toThrow(
            "LAUNCHPAD_SCHEMA_CHECK_TIMEOUT (10s) must be shorter than LAUNCHPAD_SCHEMA_CHECK_INTERVAL (10s).",
        );
        expect(at("10s", "9s").timeoutMs).toBe(9000);
        expect(() => at("10s", "11s")).toThrow(/must be shorter/);
    });

    it("refuses the default timeout with an interval of 3 s, and ignores the relation with off", () => {
        expect(() => parse({ LAUNCHPAD_SCHEMA_CHECK_INTERVAL: "3s" })).toThrow(/must be shorter/);
        expect(
            parse({
                LAUNCHPAD_SCHEMA_CHECK_INTERVAL: "off",
                LAUNCHPAD_SCHEMA_CHECK_TIMEOUT: "30s",
            }).intervalMs,
        ).toBeNull();
    });
});
