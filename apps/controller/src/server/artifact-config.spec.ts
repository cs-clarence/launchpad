import { describe, expect, it } from "vitest";
import { artifactLimitsFromEnv } from "./artifact-config";

describe("upload configuration", () => {
    it("leaves defaults alone when nothing is set, or set to empty", () => {
        expect(artifactLimitsFromEnv({})).toEqual({});
        expect(artifactLimitsFromEnv({ LAUNCHPAD_MAX_ARTIFACTS: "" })).toEqual({});
    });

    it("maps each variable to its limit", () => {
        expect(
            artifactLimitsFromEnv({
                LAUNCHPAD_MAX_UPLOAD_BYTES: "1000",
                LAUNCHPAD_MAX_EXPANDED_BYTES: "2000",
                LAUNCHPAD_MAX_ARCHIVE_ENTRIES: "30",
                LAUNCHPAD_MAX_ARCHIVE_DEPTH: "4",
                LAUNCHPAD_UPLOAD_TIMEOUT_SECONDS: "9",
                LAUNCHPAD_MAX_ARTIFACTS: "5",
            }),
        ).toEqual({
            maxUploadBytes: 1000,
            maxExpandedBytes: 2000,
            maxEntries: 30,
            maxDepth: 4,
            uploadTimeoutMs: 9000,
            maxArtifacts: 5,
        });
    });

    it("rejects a value that is set but not a positive integer", () => {
        for (const value of ["0", "-5", "1.5", "abc", "NaN", "Infinity", "1e400"]) {
            expect(
                () => artifactLimitsFromEnv({ LAUNCHPAD_MAX_UPLOAD_BYTES: value }),
                value,
            ).toThrow(/Invalid upload configuration/);
        }
    });
});
