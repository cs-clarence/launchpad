// Plain input and output types of the drift comparison (docs/design/deployment-modes.md,
// "Drift detection"). They are defined here, not derived from the database, so the comparison
// stays a pure function: no database, Dokku, router or file-system import, and nothing in these
// types can carry a credential. Generations are bigint, never number.

export type SourceRead<T> =
    | { status: "ok"; data: T }
    | { status: "unavailable" | "skipped"; reason: string };

export interface DriftDeployment {
    id: string;
    organizationId: string;
    appId: string;
    dokkuAppName: string;
    hostname: string;
    // `pending` is a deployment job still running; `retired` is gone and kept as history.
    status: "pending" | "succeeded" | "failed" | "retired";
    referencedByAliasIds: readonly string[];
    // Named by an unfinished or uncertain operation chain, so it may still be live.
    inUncertainChain: boolean;
    everPinned: boolean;
    lastUnpinnedAt: Date | null;
    artifactKey: string | null;
}

export type AliasState =
    | "unbound"
    | "bound"
    | "binding"
    | "binding-uncertain"
    | "withdrawing"
    | "withdrawal-uncertain"
    | "withdrawn";

export interface DriftAlias {
    id: string;
    appId: string;
    hostname: string;
    state: AliasState;
    reservedGeneration: bigint;
    committedGeneration: bigint;
    targetDeploymentId: string | null;
    lastOperationId: string | null;
}

export interface DriftOperation {
    id: string;
    aliasId: string;
    status:
        | "queued"
        | "applying"
        | "verifying"
        | "succeeded"
        | "failed"
        | "reconciliation-needed"
        | "superseded";
    leaseExpiresAt: Date | null;
    dispatched: boolean;
}

export interface DriftReservation {
    hostname: string;
    ownerKind: "deployment" | "alias" | "legacy_preview";
    ownerId: string;
}

export interface DriftDatabase {
    deployments: readonly DriftDeployment[];
    aliases: readonly DriftAlias[];
    operations: readonly DriftOperation[];
    reservations: readonly DriftReservation[];
    // Legacy previews and retired history: apps and reservation owners that are known.
    legacyPreviewIds: readonly string[];
    knownAppNames: readonly string[];
}

export interface DokkuRead {
    apps: readonly { name: string; domains: readonly string[] }[];
}

export interface RouterRead {
    epoch: string;
    routes: readonly {
        hostname: string;
        generation: bigint;
        operationId: string | null;
        // null is a tombstone.
        targetDeploymentId: string | null;
    }[];
}

export interface ProbeRead {
    results: readonly { hostname: string; deploymentId: string | null }[];
}

export interface ArchiveRead {
    keys: readonly string[];
}

export interface DriftConfig {
    expectedEpoch: string;
    // Limits which Dokku apps are considered. It is never evidence of ownership.
    appNamePattern: RegExp;
    now: Date;
}

export interface DriftInput {
    db: DriftDatabase;
    dokku: SourceRead<DokkuRead>;
    router: SourceRead<RouterRead>;
    probe: SourceRead<ProbeRead>;
    archives: SourceRead<ArchiveRead>;
    config: DriftConfig;
}

export const FINDING_CODES = [
    "deployment-app-missing",
    "deployment-domain-mismatch",
    "orphan-app",
    "reservation-without-owner",
    "owner-without-reservation",
    "alias-route-missing",
    "alias-router-ahead",
    "alias-router-behind",
    "alias-target-conflict",
    "router-unknown-route",
    "router-epoch-mismatch",
    "unreferenced-pin",
    "stale-unpin",
    "stuck-operation",
    "archive-missing",
    "probe-mismatch",
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

export interface ResourceRef {
    kind:
        | "deployment"
        | "alias"
        | "operation"
        | "dokku-app"
        | "router-route"
        | "reservation"
        | "archive";
    id: string;
}

export interface DriftFinding {
    code: FindingCode;
    severity: "high" | "medium";
    resources: readonly ResourceRef[];
    action: string;
    // Identifiers and decimal generations only.
    detail?: string;
}

export const SOURCE_NAMES = ["dokku", "router", "probe", "archives"] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

export interface DriftReport {
    sources: Record<SourceName, "ok" | "unavailable" | "skipped">;
    // Resources with an unfinished operation: reported, never compared.
    inFlight: readonly ResourceRef[];
    findings: readonly DriftFinding[];
    // Pattern-matching Dokku apps are considered; the rest are only counted.
    ignoredAppCount: number;
}
