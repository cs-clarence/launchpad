import { describe, expect, it } from "vitest";
import { DEFAULT_LIFECYCLE, lifecycleConfigFromEnv } from "./lifecycle";

const DAY = 86_400;

describe("lifecycle configuration", () => {
    it("is off with the documented defaults when nothing is set, or set to empty", () => {
        expect(lifecycleConfigFromEnv({})).toEqual(DEFAULT_LIFECYCLE);
        expect(
            lifecycleConfigFromEnv({ LAUNCHPAD_LIFECYCLE: "", LAUNCHPAD_DEFAULT_TTL: "" }),
        ).toEqual(DEFAULT_LIFECYCLE);
        expect(DEFAULT_LIFECYCLE).toMatchObject({
            enabled: false,
            defaultTtlSeconds: 7 * DAY,
            maxTtlSeconds: 30 * DAY,
            allowNoExpiry: false,
            artifactRetentionSeconds: 7 * DAY,
        });
    });

    it("maps each variable", () => {
        expect(
            lifecycleConfigFromEnv({
                LAUNCHPAD_LIFECYCLE: "on",
                LAUNCHPAD_DEFAULT_TTL: "24h",
                LAUNCHPAD_MAX_TTL: "14d",
                LAUNCHPAD_ALLOW_NO_EXPIRY: "on",
                LAUNCHPAD_ARTIFACT_RETENTION: "36h",
            }),
        ).toEqual({
            enabled: true,
            defaultTtlSeconds: DAY,
            maxTtlSeconds: 14 * DAY,
            allowNoExpiry: true,
            artifactRetentionSeconds: 36 * 3600,
        });
    });

    it("refuses a value that is set but invalid, naming it", () => {
        for (const [name, value] of [
            ["LAUNCHPAD_LIFECYCLE", "yes"],
            ["LAUNCHPAD_ALLOW_NO_EXPIRY", "true"],
            ["LAUNCHPAD_DEFAULT_TTL", "7"],
            ["LAUNCHPAD_DEFAULT_TTL", "0d"],
            ["LAUNCHPAD_MAX_TTL", "-1d"],
            ["LAUNCHPAD_MAX_TTL", "366d"],
            ["LAUNCHPAD_ARTIFACT_RETENTION", "1w"],
        ] as const) {
            expect(() => lifecycleConfigFromEnv({ [name]: value }), `${name}=${value}`).toThrow(
                new RegExp(name),
            );
        }
    });

    it("refuses a default lifetime longer than the maximum", () => {
        expect(() =>
            lifecycleConfigFromEnv({ LAUNCHPAD_DEFAULT_TTL: "10d", LAUNCHPAD_MAX_TTL: "5d" }),
        ).toThrow(/must not be longer/);
        // A lowered maximum alone must also leave the default valid.
        expect(() => lifecycleConfigFromEnv({ LAUNCHPAD_MAX_TTL: "3d" })).toThrow(
            /must not be longer/,
        );
        expect(lifecycleConfigFromEnv({ LAUNCHPAD_MAX_TTL: "7d" }).maxTtlSeconds).toBe(7 * DAY);
    });
});
