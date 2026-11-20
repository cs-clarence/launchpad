import { promises as fs } from "node:fs";
import path from "node:path";
import { clearDeploymentRecovery, readRecoveryMarker } from "../deployment-recovery";
import type { RecoveryEvidence } from "../recovery-evidence";

export async function ageRecoveryMarker(dataDir: string) {
    const file = path.join(dataDir, "maintenance/deployment-recovery-blocked");
    const info = await fs.lstat(file).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    });
    if (!info?.isFile()) return;
    const parsed = await readRecoveryMarker(dataDir);
    if (!parsed || parsed === "damaged") return;
    // Preserve the original on-disk version and epoch fields.
    const marker = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    marker.restoreStartedAt = "2026-01-01T00:00:00.000Z";
    await fs.writeFile(file, JSON.stringify(marker));
}

// Use only in tests covering gate/restore behavior, not source-reader correctness.
export const agreeingEvidence: RecoveryEvidence = {
    dokku: async (db) => ({
        apps: db.deployments.map((d) => ({ name: d.dokkuAppName, domains: [d.hostname] })),
    }),
    archives: async (db) => ({
        keys: db.deployments.flatMap((d) => (d.artifactKey === null ? [] : [d.artifactKey])),
    }),
};

export async function clearWithSettledFixtures(
    db: Parameters<typeof clearDeploymentRecovery>[0],
    dataDir: string,
    checked: boolean,
    router?: Parameters<typeof clearDeploymentRecovery>[3],
    options?: Partial<Parameters<typeof clearDeploymentRecovery>[4]>,
) {
    await ageRecoveryMarker(dataDir);
    return clearDeploymentRecovery(db, dataDir, checked, router, {
        evidence: agreeingEvidence,
        ...options,
    });
}
