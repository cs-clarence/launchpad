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
    // A copy with the original flags, so a sticky pattern keeps meaning "at the start of the
    // name"; lastIndex is reset before every test, because a /g or /y pattern remembers it.
    const appPattern = new RegExp(config.appNamePattern.source, config.appNamePattern.flags);
    const matchesApp = (name: string) => {
        appPattern.lastIndex = 0;
        return appPattern.test(name);
    };
    const dokku = ok(input.dokku);
    const router = ok(input.router);
    const probe = ok(input.probe);
    const archives = ok(input.archives);

    const deployments = new Map(db.deployments.map((d) => [d.id, d]));
    const aliases = new Map(db.aliases.map((a) => [a.id, a]));
    const now = config.now.getTime();

    // Operations first: a stuck one is a finding, an unfinished one makes its alias in flight.
    const busyAliases = new Set<string>();
    const oldestOpenGeneration = new Map<string, bigint>();
    for (const op of db.operations) {
        const unfinished = UNFINISHED.has(op.status);
        // Once dispatched, a missing or expired lease means the outcome is unknown, not that the
        // work can be retried. An undispatched operation is ordinary queued work, in flight.
        const expired = op.leaseExpiresAt === null || op.leaseExpiresAt.getTime() < now;
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
        if (op.generation !== undefined && (unfinished || op.status === "reconciliation-needed")) {
            const oldest = oldestOpenGeneration.get(op.aliasId);
            if (oldest === undefined || op.generation < oldest)
                oldestOpenGeneration.set(op.aliasId, op.generation);
        }
    }
    // An alias is in flight while it is in a transitional state or has an unfinished operation. A
    // reserved generation above the committed one is NOT in flight by itself: numbers are never
    // reused, so a failed operation leaves a permanent gap, and a settled alias must stay comparable.
    for (const alias of db.aliases) {
        const transitional =
            alias.state !== "bound" && alias.state !== "unbound" && alias.state !== "withdrawn";
        if (transitional) busyAliases.add(alias.id);
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
            if (!matchesApp(app.name)) {
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
            if (busyAliases.has(a.id) && !config.recovery) continue;
            const route = routes.get(a.hostname);
            const ref = [{ kind: "alias", id: a.id } as const];
            // A bound alias needs its route and a withdrawn one its tombstone, which keeps the
            // withdrawal fence; only a never-bound alias may have no router row at all.
            if (
                config.recovery
                    ? a.committedGeneration > 0n
                    : a.state === "bound" || a.state === "withdrawn"
            ) {
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
                    (config.recovery &&
                        a.targetDeploymentId !== null &&
                        route.targetHostname !== deployments.get(a.targetDeploymentId)?.hostname) ||
                    (route.operationId !== null &&
                        a.lastOperationId !== null &&
                        route.operationId !== a.lastOperationId)
                ) {
                    findings.push(finding("alias-target-conflict", ref));
                }
            } else if (
                route &&
                (route.targetDeploymentId !== null ||
                    (config.recovery &&
                        (route.generation > a.reservedGeneration ||
                            route.generation >=
                                (oldestOpenGeneration.get(a.id) ?? route.generation + 1n))))
            ) {
                // Unbound or withdrawn, yet the router still serves something.
                findings.push(finding("alias-target-conflict", ref));
            }
        }
        const owned = new Set(db.aliases.map((a) => a.hostname));
        for (const route of router.routes) {
            if (
                !owned.has(route.hostname) &&
                (!config.recovery || route.targetDeploymentId !== null)
            )
                findings.push(
                    finding("router-unknown-route", [{ kind: "router-route", id: route.hostname }]),
                );
        }
    }

    if (archives) {
        const stored = new Set(archives.keys);
        for (const d of db.deployments) {
            // Retained means not retired and not still being built: a failed deployment awaiting
            // cleanup keeps its archive too. Retired history owes nobody an archive.
            const retained = d.status !== "retired" && !busyDeployments.has(d.id);
            if (retained && d.artifactKey !== null && !stored.has(d.artifactKey)) {
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
        // Each expectation remembers the database resource it came from, so a finding names it and
        // `stableDrift` can drop the result when that resource moved between the two snapshots.
        const expected = new Map<string, { id: string | null; owner: ResourceRef }>();
        for (const d of db.deployments)
            if (expectsApp(d) && !busyDeployments.has(d.id))
                expected.set(d.hostname, { id: d.id, owner: { kind: "deployment", id: d.id } });
        // A bound alias serves its target; an unbound or withdrawn one serves nothing (null).
        for (const a of db.aliases) {
            if (busyAliases.has(a.id) && !config.recovery) continue;
            const owner: ResourceRef = { kind: "alias", id: a.id };
            if (config.recovery) {
                expected.set(a.hostname, { id: a.targetDeploymentId, owner });
            } else if (a.state === "bound" && a.targetDeploymentId !== null)
                expected.set(a.hostname, { id: a.targetDeploymentId, owner });
            else if (a.state === "unbound" || a.state === "withdrawn")
                expected.set(a.hostname, { id: null, owner });
        }
        for (const result of probe.results) {
            const want = expected.get(result.hostname);
            if (want !== undefined && result.deploymentId !== want.id) {
                findings.push(
                    finding("probe-mismatch", [
                        { kind: "router-route", id: result.hostname },
                        want.owner,
                    ]),
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

const resourceKey = (f: DriftFinding) => `${f.code}|${f.resources.map(keyOf).toSorted().join(",")}`;

function fingerprint(db: DriftDatabase) {
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
                d.everPinned,
                d.artifactKey,
                d.lastUnpinnedAt?.toISOString(),
            ].join("|"),
        );
    }
    for (const o of db.operations)
        map.set(
            `operation:${o.id}`,
            [o.status, o.aliasId, o.dispatched, o.leaseExpiresAt?.toISOString()].join("|"),
        );
    return map;
}

// A promotion or a new deployment can land while the remote sources are being read. The remote
// reads are fixed, so compare them against the database as it was before AND as it is after, and
// keep only what both snapshots report and whose database resources did not change in between.
// Findings keyed on Dokku apps, router routes, reservations or archives are covered too: a race
// shows up as a difference between the two comparisons, not only as a changed row.
export function stableDrift(before: DriftInput, afterDb: DriftDatabase): DriftReport {
    const first = compareDrift(before);
    const second = compareDrift({ ...before, db: afterDb });
    const again = new Set(second.findings.map(resourceKey));
    const was = fingerprint(before.db);
    const now = fingerprint(afterDb);
    const changed = (ref: ResourceRef) => was.get(keyOf(ref)) !== now.get(keyOf(ref));
    return {
        ...first,
        findings: first.findings.filter(
            (f) => again.has(resourceKey(f)) && !f.resources.some(changed),
        ),
        inFlight: [
            ...new Map([...first.inFlight, ...second.inFlight].map((r) => [keyOf(r), r])).values(),
        ],
    };
}

// Pass the report of `stableDrift` (not a single-snapshot one) when the database may have moved.
// 2 when a requested source was unavailable (even with findings), 1 for findings, 3 when a source
// was skipped and nothing was found (not a clean result: part of the system was not looked at), 0
// only when every source was read and nothing was found.
export function driftExitCode(report: DriftReport): 0 | 1 | 2 | 3 {
    const sources = Object.values(report.sources);
    if (sources.includes("unavailable")) return 2;
    if (report.findings.length > 0) return 1;
    return sources.includes("skipped") ? 3 : 0;
}
