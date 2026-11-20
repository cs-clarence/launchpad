import type {
    ArchiveRead,
    DokkuRead,
    DriftDatabase,
    DriftFinding,
    DriftReport,
    ProbeRead,
} from "./drift/types";

export interface RecoveryEvidence {
    dokku: (snapshot: DriftDatabase) => Promise<DokkuRead>;
    archives: (snapshot: DriftDatabase) => Promise<ArchiveRead>;
    // When configured, a failed probe is an unavailable source, not an accept-able finding.
    probe?: (snapshot: DriftDatabase) => Promise<ProbeRead>;
}

const ACCEPTABLE = new Map<DriftFinding["code"], string>([
    ["deployment-app-missing", "deployment"],
    ["deployment-domain-mismatch", "deployment"],
    ["archive-missing", "deployment"],
    ["probe-mismatch", "owner"],
]);

function acceptanceKey(finding: DriftFinding): string | undefined {
    const kind = ACCEPTABLE.get(finding.code);
    if (!kind) return undefined;
    const resource = finding.resources.find((r) =>
        kind === "owner" ? r.kind === "alias" || r.kind === "deployment" : r.kind === kind,
    );
    return resource && `${finding.code}:${resource.id}`;
}

export function assessRecoveryEvidence(report: DriftReport, acceptedKeys: readonly string[]) {
    const available = new Map<string, DriftFinding>();
    for (const finding of report.findings) {
        const key = acceptanceKey(finding);
        if (key) available.set(key, finding);
    }
    const keys = new Set(acceptedKeys);
    if (keys.size !== acceptedKeys.length || acceptedKeys.some((key) => !available.has(key))) {
        throw new Error(
            "--accept must name each current, acceptable finding exactly once (code:resource-id).",
        );
    }
    return {
        accepted: [...keys].map((key) => ({ key, finding: available.get(key)! })),
        blocking: report.findings.filter((finding) => {
            const blocking = finding.severity === "high" || finding.code === "alias-router-ahead";
            return blocking && !keys.has(acceptanceKey(finding) ?? "");
        }),
    };
}
