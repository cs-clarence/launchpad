import type { ArtifactLimits } from "@launchpad/services";
import { z } from "zod";

const positiveInt = z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional();

const schema = z.object({
    LAUNCHPAD_MAX_UPLOAD_BYTES: positiveInt,
    LAUNCHPAD_MAX_EXPANDED_BYTES: positiveInt,
    LAUNCHPAD_MAX_ARCHIVE_ENTRIES: positiveInt,
    LAUNCHPAD_MAX_ARCHIVE_DEPTH: positiveInt,
    LAUNCHPAD_UPLOAD_TIMEOUT_SECONDS: positiveInt,
    LAUNCHPAD_MAX_ARTIFACTS: positiveInt,
});

// Upload limits from the environment. Unset means the documented default; a set but
// invalid value is an error at startup, never a silent fallback.
export function artifactLimitsFromEnv(
    env: Record<string, string | undefined>,
): Partial<ArtifactLimits> {
    const picked = Object.fromEntries(
        Object.keys(schema.shape).map((key) => [key, env[key] === "" ? undefined : env[key]]),
    );
    const parsed = schema.safeParse(picked);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
        throw new Error(`Invalid upload configuration: ${issues.join("; ")}`);
    }
    const v = parsed.data;
    const limits: Partial<ArtifactLimits> = {};
    if (v.LAUNCHPAD_MAX_UPLOAD_BYTES) limits.maxUploadBytes = v.LAUNCHPAD_MAX_UPLOAD_BYTES;
    if (v.LAUNCHPAD_MAX_EXPANDED_BYTES) limits.maxExpandedBytes = v.LAUNCHPAD_MAX_EXPANDED_BYTES;
    if (v.LAUNCHPAD_MAX_ARCHIVE_ENTRIES) limits.maxEntries = v.LAUNCHPAD_MAX_ARCHIVE_ENTRIES;
    if (v.LAUNCHPAD_MAX_ARCHIVE_DEPTH) limits.maxDepth = v.LAUNCHPAD_MAX_ARCHIVE_DEPTH;
    if (v.LAUNCHPAD_UPLOAD_TIMEOUT_SECONDS) {
        limits.uploadTimeoutMs = v.LAUNCHPAD_UPLOAD_TIMEOUT_SECONDS * 1000;
    }
    if (v.LAUNCHPAD_MAX_ARTIFACTS) limits.maxArtifacts = v.LAUNCHPAD_MAX_ARTIFACTS;
    return limits;
}
