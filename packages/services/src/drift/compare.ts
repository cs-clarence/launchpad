import type {
    DriftDatabase,
    DriftFinding,
    DriftInput,
    DriftReport,
    FindingCode,
    ResourceRef,
    SourceName,
    SourceRead,
} from "./types";

// What an operator does about each finding. Every action is advice: nothing here repairs,
// deletes or re-routes anything.
const ACTION: Record<FindingCode, { severity: "high" | "medium"; action: string }> = {
    "deployment-app-missing": {
        severity: "high",
        action: "Investigate; redeploy the artifact as a new deployment.",
    },
    "deployment-domain-mismatch": {
        severity: "high",
        action: "Find who changed it; do not edit the record to match.",
    },
    "orphan-app": {
        severity: "medium",
        action: "Identify the owner; deletion is a separate, exact-name, authorized action.",
    },
    "reservation-without-owner": {
        severity: "high",
        action: "Integrity alarm; stop mutations and investigate.",
    },
    "owner-without-reservation": {
        severity: "high",
        action: "Integrity alarm; stop mutations and investigate.",
    },
    "alias-route-missing": { severity: "high", action: "Reconcile through a promotion operation." },
    "alias-router-ahead": {
        severity: "medium",
        action: "Keep it; raise reserved_generation as the restore rule says.",
    },
    "alias-router-behind": { severity: "high", action: "Reconcile; the route may have been lost." },
    "alias-target-conflict": {
        severity: "high",
        action: "Stop promotions for the alias; investigate before correcting.",
    },
    "router-unknown-route": {
        severity: "high",
        action: "Pin its target; withdraw or record it after review.",
    },
    "router-epoch-mismatch": {
        severity: "high",
        action: "Expected after a restore until the epoch is re-established; otherwise investigate.",
    },
    "unreferenced-pin": { severity: "medium", action: "Recompute pins under the normal locks." },
    "stale-unpin": { severity: "high", action: "Recompute pins; do not collect it." },
    "stuck-operation": {
        severity: "medium",
        action: "Resolve it through the reconciliation workflow.",
    },
    "archive-missing": { severity: "high", action: "Repair from a backup before any redeploy." },
    "probe-mismatch": { severity: "high", action: "Compare route and target before any change." },
};

const UNFINISHED = new Set(["queued", "applying", "verifying"]);

function finding(code: FindingCode, resources: ResourceRef[], detail?: string): DriftFinding {
    const { severity, action } = ACTION[code];
    return detail === undefined
        ? { code, severity, resources, action }
        : { code, severity, resources, action, detail };
}

const ok = <T>(read: SourceRead<T>): T | null => (read.status === "ok" ? read.data : null);
const keyOf = (ref: ResourceRef) => `${ref.kind}:${ref.id}`;

// Compares the database with what Dokku, the alias router, a route probe and the archive store
// report. A finding is produced only from a source that was read; an unavailable or skipped one
// is reported as such and is never a clean result. Resources with an unfinished operation are
// "in flight" and are not compared. Matching is by recorded identity (names, hostnames,
// operation IDs); the app-name pattern only decides which Dokku apps are looked at.
export function compareDrift(input: DriftInput): DriftReport {
    const { db, config } = input;
    const findings: DriftFinding[] = [];
    const inFlight: ResourceRef[] = [];
    const dokku = ok(input.dokku);
    const router = ok(input.router);
    const probe = ok(input.probe);
    const archives = ok(input.archives);

    const deployments = new Map(db.deployments.map((d) => [d.id, d]));
    const aliases = new Map(db.aliases.map((a) => [a.id, a]));
    const now = config.now.getTime();

    // Operations first: a stuck one is a finding, an unfinished one makes its alias in flight.
    const busyAliases = new Set<string>();
    for (const op of db.operations) {
        const unfinished = UNFINISHED.has(op.status);
        const expired = op.leaseExpiresAt !== null && op.leaseExpiresAt.getTime() < now;
        if (op.status === "reconciliation-needed" || (unfinished && op.dispatched && expired)) {
            findings.push(
                finding("stuck-operation", [
                    { kind: "operation", id: op.id },
                    { kind: "alias", id: op.aliasId },
                ]),
            );
            busyAliases.add(op.aliasId);
        } else if (unfinished) {
            busyAliases.add(op.aliasId);
        }
    }
    for (const alias of db.aliases) {
        const transitional =
            alias.state !== "bound" && alias.state !== "unbound" && alias.state !== "withdrawn";
        if (transitional || alias.reservedGeneration > alias.committedGeneration)
            busyAliases.add(alias.id);
    }
    for (const id of busyAliases) {
        if (aliases.has(id)) inFlight.push({ kind: "alias", id });
    }
    const busyDeployments = new Set(
        db.deployments.filter((d) => d.status === "pending").map((d) => d.id),
    );
    for (const id of busyDeployments) inFlight.push({ kind: "deployment", id });

    // Pins and reservations are database-only and always compared.
    const reservationByHostname = new Map<string, DriftDatabase["reservations"][number]>();
    for (const reservation of db.reservations)
        reservationByHostname.set(reservation.hostname, reservation);
    const legacy = new Set(db.legacyPreviewIds);
    for (const reservation of db.reservations) {
        const owner =
            reservation.ownerKind === "deployment"
                ? deployments.has(reservation.ownerId)
                : reservation.ownerKind === "alias"
                  ? aliases.has(reservation.ownerId)
                  : legacy.has(reservation.ownerId);
        if (!owner)
            findings.push(
                finding("reservation-without-owner", [
                    { kind: "reservation", id: reservation.hostname },
                ]),
            );
    }
    for (const d of db.deployments) {
        const held = reservationByHostname.get(d.hostname);
        if (!held || held.ownerKind !== "deployment" || held.ownerId !== d.id) {
            findings.push(finding("owner-without-reservation", [{ kind: "deployment", id: d.id }]));
        }
        const referenced = d.referencedByAliasIds.length > 0 || d.inUncertainChain;
        if (referenced && d.lastUnpinnedAt !== null)
            findings.push(finding("stale-unpin", [{ kind: "deployment", id: d.id }]));
        if (!referenced && d.everPinned && d.lastUnpinnedAt === null) {
            findings.push(finding("unreferenced-pin", [{ kind: "deployment", id: d.id }]));
        }
    }
    for (const a of db.aliases) {
        const held = reservationByHostname.get(a.hostname);
        if (!held || held.ownerKind !== "alias" || held.ownerId !== a.id) {
            findings.push(finding("owner-without-reservation", [{ kind: "alias", id: a.id }]));
        }
    }

    // Dokku: a live deployment's app and domain, and apps nothing in the database names.
    const expectsApp = (d: DriftDatabase["deployments"][number]) =>
        d.status !== "retired" &&
        d.status !== "pending" &&
        (d.status === "succeeded" || d.referencedByAliasIds.length > 0 || d.inUncertainChain);
    let ignoredAppCount = 0;
    if (dokku) {
        const apps = new Map(dokku.apps.map((a) => [a.name, a]));
        for (const d of db.deployments) {
            if (!expectsApp(d) || busyDeployments.has(d.id)) continue;
            const app = apps.get(d.dokkuAppName);
            if (!app) {
                findings.push(
                    finding("deployment-app-missing", [
                        { kind: "deployment", id: d.id },
                        { kind: "dokku-app", id: d.dokkuAppName },
                    ]),
                );
            } else if (!app.domains.includes(d.hostname)) {
                findings.push(
                    finding("deployment-domain-mismatch", [
                        { kind: "deployment", id: d.id },
                        { kind: "dokku-app", id: d.dokkuAppName },
                    ]),
                );
            }
        }
        const known = new Set([...db.deployments.map((d) => d.dokkuAppName), ...db.knownAppNames]);
        for (const app of dokku.apps) {
            if (!config.appNamePattern.test(app.name)) {
                ignoredAppCount++;
            } else if (!known.has(app.name)) {
                findings.push(finding("orphan-app", [{ kind: "dokku-app", id: app.name }]));
            }
        }
    }

    // Router: every alias route against the committed state, and routes nobody owns.
    if (router) {
        if (router.epoch !== config.expectedEpoch) {
            findings.push(
                finding("router-epoch-mismatch", [{ kind: "router-route", id: "epoch" }]),
            );
        }
        const routes = new Map(router.routes.map((r) => [r.hostname, r]));
        for (const a of db.aliases) {
            if (busyAliases.has(a.id)) continue;
            const route = routes.get(a.hostname);
            const ref = [{ kind: "alias", id: a.id } as const];
            if (a.state === "bound") {
                if (!route) {
                    findings.push(finding("alias-route-missing", ref));
                } else if (route.generation > a.committedGeneration) {
                    findings.push(
                        finding(
                            "alias-router-ahead",
                            ref,
                            `router ${route.generation}, database ${a.committedGeneration}`,
                        ),
                    );
                } else if (route.generation < a.committedGeneration) {
                    findings.push(
                        finding(
                            "alias-router-behind",
                            ref,
                            `router ${route.generation}, database ${a.committedGeneration}`,
                        ),
                    );
                } else if (
                    route.targetDeploymentId !== a.targetDeploymentId ||
                    (route.operationId !== null &&
                        a.lastOperationId !== null &&
                        route.operationId !== a.lastOperationId)
                ) {
                    findings.push(finding("alias-target-conflict", ref));
                }
            } else if (route && route.targetDeploymentId !== null) {
                // Unbound or withdrawn, yet the router still serves something.
                findings.push(finding("alias-target-conflict", ref));
            }
        }
        const owned = new Set(db.aliases.map((a) => a.hostname));
        for (const route of router.routes) {
            if (!owned.has(route.hostname))
                findings.push(
                    finding("router-unknown-route", [{ kind: "router-route", id: route.hostname }]),
                );
        }
    }

    if (archives) {
        const stored = new Set(archives.keys);
        for (const d of db.deployments) {
            if (d.artifactKey !== null && d.status === "succeeded" && !stored.has(d.artifactKey)) {
                findings.push(
                    finding("archive-missing", [
                        { kind: "deployment", id: d.id },
                        { kind: "archive", id: d.artifactKey },
                    ]),
                );
            }
        }
    }

    if (probe) {
        const expected = new Map<string, string>();
        for (const d of db.deployments)
            if (expectsApp(d) && !busyDeployments.has(d.id)) expected.set(d.hostname, d.id);
        for (const a of db.aliases) {
            if (a.state === "bound" && !busyAliases.has(a.id) && a.targetDeploymentId !== null)
                expected.set(a.hostname, a.targetDeploymentId);
        }
        for (const result of probe.results) {
            const want = expected.get(result.hostname);
            if (want !== undefined && result.deploymentId !== want) {
                findings.push(
                    finding("probe-mismatch", [{ kind: "router-route", id: result.hostname }]),
                );
            }
        }
    }

    const status = (name: SourceName) => input[name].status;
    return {
        sources: {
            dokku: status("dokku"),
            router: status("router"),
            probe: status("probe"),
            archives: status("archives"),
        },
        inFlight,
        findings,
        ignoredAppCount,
    };
}

// Findings are kept only when their resources did not change between two database snapshots taken
// before and after the remote reads, so a promotion that lands in between is not a false alarm.
export function stableFindings(
    before: DriftDatabase,
    after: DriftDatabase,
    findings: readonly DriftFinding[],
): DriftFinding[] {
    const fingerprint = (db: DriftDatabase) => {
        const map = new Map<string, string>();
        for (const a of db.aliases) {
            map.set(
                `alias:${a.id}`,
                [
                    a.state,
                    a.reservedGeneration,
                    a.committedGeneration,
                    a.targetDeploymentId,
                    a.lastOperationId,
                ].join("|"),
            );
        }
        for (const d of db.deployments) {
            map.set(
                `deployment:${d.id}`,
                [
                    d.status,
                    d.referencedByAliasIds.join(","),
                    d.inUncertainChain,
                    d.lastUnpinnedAt?.toISOString(),
                ].join("|"),
            );
        }
        for (const o of db.operations)
            map.set(`operation:${o.id}`, [o.status, o.aliasId, o.dispatched].join("|"));
        return map;
    };
    const was = fingerprint(before);
    const now = fingerprint(after);
    const changed = (ref: ResourceRef) => was.get(keyOf(ref)) !== now.get(keyOf(ref));
    return findings.filter((f) => !f.resources.some(changed));
}

// 2 when a requested source was unavailable (even with findings), 1 for findings when every
// requested source was read, 0 otherwise. A skipped source is reported, not counted.
export function driftExitCode(report: DriftReport): 0 | 1 | 2 {
    if (Object.values(report.sources).includes("unavailable")) return 2;
    return report.findings.length > 0 ? 1 : 0;
}
