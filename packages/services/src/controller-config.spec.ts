import { describe, expect, it } from "vitest";
import { DEPLOYMENT_LEASE_MS } from "./deployment-claims";
import { effectiveStaleSeconds } from "./heartbeat";
import {
    MAX_STALE_SECONDS,
    MAX_WARN_SECONDS,
    parseHeartbeatConfig,
    parseSchemaCheckConfig,
} from "./controller-config";

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

describe("worker heartbeat settings", () => {
    const worker = (env: Record<string, string>) => parseHeartbeatConfig(env, "worker");
    const controller = (env: Record<string, string>) => parseHeartbeatConfig(env, "controller");
    const BEAT = "LAUNCHPAD_WORKER_HEARTBEAT_INTERVAL";
    const STALE = "LAUNCHPAD_WORKER_STALE_AFTER";
    const WARN = "LAUNCHPAD_LEASE_WARN_BEFORE";
    const PRUNE = "LAUNCHPAD_WORKER_PRUNE_AFTER";

    it("has the planned defaults, also when empty", () => {
        const expected = {
            beatSeconds: 15,
            staleAfterSeconds: 60,
            warnBeforeSeconds: 90,
            pruneAfterSeconds: 7 * 86_400,
        };
        expect(worker({})).toEqual(expected);
        expect(controller({})).toEqual(expected);
        expect(worker({ [BEAT]: "", [STALE]: "", [PRUNE]: "" })).toEqual(expected);
    });

    it("derives the upper bounds from the lease, so a lease change moves them", () => {
        const lease = DEPLOYMENT_LEASE_MS / 1000;
        expect(MAX_STALE_SECONDS).toBe(lease - 60);
        expect(MAX_WARN_SECONDS).toBe(lease - 60);
        expect(MAX_STALE_SECONDS).toBe(240);
    });

    describe("beat 5 s to 60 s (worker)", () => {
        it.each([
            ["5s", true],
            ["60s", true],
            ["1m", true],
            ["4s", false],
            ["61s", false],
            ["0s", false],
            ["soon", false],
        ])("%s ok=%s", (value, ok) => {
            // Keep the stale relation satisfied so only the bound is under test.
            const env = { [BEAT]: value, [STALE]: "240s" };
            if (ok) expect(worker(env).beatSeconds).toBeGreaterThanOrEqual(5);
            else expect(() => worker(env)).toThrow(`${BEAT} must be a duration from 5s to 1m.`);
        });
    });

    describe("stale 15 s to 240 s (both)", () => {
        it.each([
            ["14s", false],
            ["15s", true],
            ["240s", true],
            ["4m", true],
            ["241s", false],
        ])("%s ok=%s", (value, ok) => {
            for (const parse of [worker, controller]) {
                const env = { [BEAT]: "5s", [STALE]: value };
                if (ok) expect(parse(env).staleAfterSeconds).toBeGreaterThanOrEqual(15);
                else
                    expect(() => parse(env)).toThrow(`${STALE} must be a duration from 15s to 4m.`);
            }
        });
    });

    describe("stale must be at least 3 times the beat (worker)", () => {
        it.each([
            [20, 60, true],
            [21, 60, false],
            [5, 15, true],
            [60, 180, true],
            [60, 179, false],
            [60, 240, true],
        ])("beat %i s, stale %i s: ok=%s", (beat, stale, ok) => {
            const env = { [BEAT]: `${beat}s`, [STALE]: `${stale}s` };
            if (ok) expect(worker(env).staleAfterSeconds).toBe(stale);
            else {
                expect(() => worker(env)).toThrow(`${STALE} must be at least 3 times ${BEAT} (`);
            }
        });

        it("is not checked on the controller, which does not read the beat", () => {
            expect(controller({ [BEAT]: "60s", [STALE]: "15s" }).staleAfterSeconds).toBe(15);
        });
    });

    describe("lease warning 30 s to 240 s (controller)", () => {
        it.each([
            ["29s", false],
            ["30s", true],
            ["240s", true],
            ["241s", false],
        ])("%s ok=%s", (value, ok) => {
            if (ok) expect(controller({ [WARN]: value }).warnBeforeSeconds).toBeGreaterThan(0);
            else
                expect(() => controller({ [WARN]: value })).toThrow(
                    `${WARN} must be a duration from 30s to 4m.`,
                );
        });

        it("is not read by the worker", () => {
            expect(worker({ [WARN]: "nonsense" }).warnBeforeSeconds).toBe(90);
        });
    });

    describe("prune 1 h to 90 d (worker)", () => {
        it.each([
            ["59m", false],
            ["3599s", false],
            ["1h", true],
            ["90d", true],
            ["91d", false],
        ])("%s ok=%s", (value, ok) => {
            if (ok) expect(worker({ [PRUNE]: value }).pruneAfterSeconds).toBeGreaterThan(0);
            else
                expect(() => worker({ [PRUNE]: value })).toThrow(
                    `${PRUNE} must be a duration from 1h to 90d.`,
                );
        });

        it("is not read by the controller", () => {
            expect(controller({ [PRUNE]: "nonsense" }).pruneAfterSeconds).toBe(7 * 86_400);
        });
    });

    it("never lets a stopped worker's lease expire before a warning: the arithmetic table", () => {
        const lease = DEPLOYMENT_LEASE_MS / 1000;
        for (const beat of [5, 60]) {
            for (const stale of [15, 240]) {
                const effective = effectiveStaleSeconds(stale, beat);
                // The "no worker" warning is at least 60 s before the lease can expire.
                expect(effective).toBeLessThanOrEqual(lease - 60);
                for (const warn of [30, 240]) {
                    const fires = Math.max(effective, lease - warn);
                    expect(fires).toBeLessThan(lease);
                }
            }
        }
        expect(effectiveStaleSeconds(15, 5)).toBe(15);
        expect(effectiveStaleSeconds(15, 60)).toBe(180);
        expect(effectiveStaleSeconds(240, 5)).toBe(240);
        expect(effectiveStaleSeconds(240, 60)).toBe(240);
    });

    it("clamps a hand-edited beat_seconds", () => {
        expect(effectiveStaleSeconds(60, 1)).toBe(60);
        expect(effectiveStaleSeconds(60, 3600)).toBe(180);
        expect(effectiveStaleSeconds(15, -4)).toBe(15);
    });
});
