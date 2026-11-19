import { describe, expect, it } from "vitest";
import { compareDrift, driftExitCode, stableDrift } from "./compare";
import {
    FINDING_CODES,
    type DriftAlias,
    type DriftDatabase,
    type DriftDeployment,
    type DriftInput,
    type DriftOperation,
    type FindingCode,
} from "./types";

const NOW = new Date("2026-11-19T12:00:00Z");
const PAST = new Date("2026-11-19T11:00:00Z");
const FUTURE = new Date("2026-11-19T13:00:00Z");

const deployment = (id: string, over: Partial<DriftDeployment> = {}): DriftDeployment => ({
    id,
    organizationId: "org",
    appId: "app",
    dokkuAppName: `lp-${id}`,
    hostname: `${id}-preview.sites.example.net`,
    status: "succeeded",
    referencedByAliasIds: [],
    inUncertainChain: false,
    everPinned: false,
    lastUnpinnedAt: null,
    artifactKey: `artifacts/${id}`,
    ...over,
});

const alias = (over: Partial<DriftAlias> = {}): DriftAlias => ({
    id: "prod",
    appId: "app",
    hostname: "view-prod.sites.example.net",
    state: "bound",
    reservedGeneration: 3n,
    committedGeneration: 3n,
    targetDeploymentId: "a",
    lastOperationId: "op1",
    ...over,
});

// Everything agrees: deployment a is live behind the production alias, b is an unpinned preview.
function agreeing(): DriftInput {
    const a = deployment("a", { referencedByAliasIds: ["prod"], everPinned: true });
    const b = deployment("b");
    const db: DriftDatabase = {
        deployments: [a, b],
        aliases: [alias()],
        operations: [
            {
                id: "op1",
                aliasId: "prod",
                status: "succeeded",
                leaseExpiresAt: null,
                dispatched: true,
            },
        ],
        reservations: [
            { hostname: a.hostname, ownerKind: "deployment", ownerId: "a" },
            { hostname: b.hostname, ownerKind: "deployment", ownerId: "b" },
            { hostname: "view-prod.sites.example.net", ownerKind: "alias", ownerId: "prod" },
        ],
        legacyPreviewIds: [],
        knownAppNames: [],
    };
    return {
        db,
        dokku: {
            status: "ok",
            data: {
                apps: [
                    { name: "lp-a", domains: [a.hostname] },
                    { name: "lp-b", domains: [b.hostname] },
                    { name: "unrelated-site", domains: ["x.example.org"] },
                ],
            },
        },
        router: {
            status: "ok",
            data: {
                epoch: "epoch-1",
                routes: [
                    {
                        hostname: "view-prod.sites.example.net",
                        generation: 3n,
                        operationId: "op1",
                        targetDeploymentId: "a",
                    },
                ],
            },
        },
        probe: {
            status: "ok",
            data: {
                results: [
                    { hostname: a.hostname, deploymentId: "a" },
                    { hostname: "view-prod.sites.example.net", deploymentId: "a" },
                ],
            },
        },
        archives: { status: "ok", data: { keys: ["artifacts/a", "artifacts/b"] } },
        config: { expectedEpoch: "epoch-1", appNamePattern: /^lp-[a-z0-9]+$/, now: NOW },
    };
}

const okApps = (input: DriftInput) => (input.dokku.status === "ok" ? input.dokku.data.apps : []);
const codes = (input: DriftInput) => compareDrift(input).findings.map((f) => f.code);
const withDb = (input: DriftInput, db: Partial<DriftDatabase>): DriftInput => ({
    ...input,
    db: { ...input.db, ...db },
});
const routerWith = (
    input: DriftInput,
    routes: NonNullable<Extract<DriftInput["router"], { status: "ok" }>["data"]>["routes"],
    epoch = "epoch-1",
): DriftInput => ({
    ...input,
    router: { status: "ok", data: { epoch, routes } },
});

// One case per finding code: each is produced here and is absent in the agreeing fixture.
const cases: Record<FindingCode, (input: DriftInput) => DriftInput> = {
    "deployment-app-missing": (i) => ({
        ...i,
        dokku: {
            status: "ok",
            data: { apps: [{ name: "lp-b", domains: ["b-preview.sites.example.net"] }] },
        },
    }),
    "deployment-domain-mismatch": (i) => ({
        ...i,
        dokku: {
            status: "ok",
            data: {
                apps: [
                    { name: "lp-a", domains: ["changed.example.net"] },
                    { name: "lp-b", domains: ["b-preview.sites.example.net"] },
                ],
            },
        },
    }),
    "orphan-app": (i) => ({
        ...i,
        dokku: {
            status: "ok",
            data: {
                apps: [
                    ...(i.dokku.status === "ok" ? i.dokku.data.apps : []),
                    { name: "lp-stray", domains: [] },
                ],
            },
        },
    }),
    "reservation-without-owner": (i) =>
        withDb(i, {
            reservations: [
                ...i.db.reservations,
                {
                    hostname: "gone.sites.example.net",
                    ownerKind: "deployment",
                    ownerId: "missing",
                },
            ],
        }),
    "owner-without-reservation": (i) =>
        withDb(i, { reservations: i.db.reservations.filter((r) => r.ownerId !== "b") }),
    "alias-route-missing": (i) => routerWith(i, []),
    "alias-router-ahead": (i) =>
        routerWith(i, [
            {
                hostname: "view-prod.sites.example.net",
                generation: 9n,
                operationId: "op9",
                targetDeploymentId: "b",
            },
        ]),
    "alias-router-behind": (i) =>
        routerWith(i, [
            {
                hostname: "view-prod.sites.example.net",
                generation: 1n,
                operationId: "op0",
                targetDeploymentId: "a",
            },
        ]),
    "alias-target-conflict": (i) =>
        routerWith(i, [
            {
                hostname: "view-prod.sites.example.net",
                generation: 3n,
                operationId: "op1",
                targetDeploymentId: "b",
            },
        ]),
    "router-unknown-route": (i) =>
        routerWith(i, [
            ...(i.router.status === "ok" ? i.router.data.routes : []),
            {
                hostname: "stray.sites.example.net",
                generation: 1n,
                operationId: "x",
                targetDeploymentId: "a",
            },
        ]),
    "router-epoch-mismatch": (i) =>
        routerWith(i, i.router.status === "ok" ? i.router.data.routes : [], "epoch-2"),
    "unreferenced-pin": (i) => {
        // The alias is unbound, so nothing references deployment a any more; the router and the
        // probe agree that it serves nothing.
        const unbound = withDb(i, {
            deployments: [deployment("a", { everPinned: true }), deployment("b")],
            aliases: [
                alias({
                    state: "unbound",
                    targetDeploymentId: null,
                    committedGeneration: 0n,
                    reservedGeneration: 0n,
                }),
            ],
        });
        return {
            ...routerWith(unbound, []),
            probe: { status: "ok", data: { results: [] } },
        };
    },
    "stale-unpin": (i) =>
        withDb(i, {
            deployments: [
                deployment("a", {
                    referencedByAliasIds: ["prod"],
                    everPinned: true,
                    lastUnpinnedAt: PAST,
                }),
                deployment("b"),
            ],
        }),
    "stuck-operation": (i) =>
        withDb(i, {
            operations: [
                {
                    id: "op2",
                    aliasId: "prod",
                    status: "applying",
                    leaseExpiresAt: PAST,
                    dispatched: true,
                },
            ],
        }),
    "archive-missing": (i) => ({
        ...i,
        archives: { status: "ok", data: { keys: ["artifacts/b"] } },
    }),
    "probe-mismatch": (i) => ({
        ...i,
        probe: {
            status: "ok",
            data: { results: [{ hostname: "view-prod.sites.example.net", deploymentId: "b" }] },
        },
    }),
};

describe("compareDrift", () => {
    it("finds nothing when every source agrees, and ignores apps that are not Launchpad's", () => {
        const report = compareDrift(agreeing());
        expect(report.findings).toEqual([]);
        expect(report.ignoredAppCount).toBe(1);
        expect(driftExitCode(report)).toBe(0);
    });

    it("has a case for every finding code", () => {
        expect(Object.keys(cases).toSorted()).toEqual([...FINDING_CODES].toSorted());
    });

    it.each(FINDING_CODES)("reports %s from a fixture and only that code", (code) => {
        const found = codes(cases[code](agreeing()));
        expect(found).toContain(code);
        expect(found.every((c) => c === code)).toBe(true);
    });

    it("tells a router that is ahead after a restore apart from a real conflict", () => {
        const ahead = codes(cases["alias-router-ahead"](agreeing()));
        expect(ahead).toEqual(["alias-router-ahead"]);
        expect(ahead).not.toContain("alias-target-conflict");
    });

    it("never gives a clean result for an unavailable or skipped source", () => {
        const input = {
            ...agreeing(),
            dokku: { status: "unavailable", reason: "ssh timed out" } as const,
            router: { status: "skipped", reason: "--no-router" } as const,
        };
        const report = compareDrift(input);
        expect(report.sources).toMatchObject({ dokku: "unavailable", router: "skipped" });
        expect(report.findings).toEqual([]);
        expect(driftExitCode(report)).toBe(2);
        // Findings that need the unread sources are not invented.
        const gone = compareDrift({ ...input, db: { ...input.db, deployments: [] } });
        expect(gone.findings.map((f) => f.code)).not.toContain("deployment-app-missing");
    });

    it("exits 1 for findings when every source was read, 2 when one was unavailable even with findings", () => {
        const found = compareDrift(cases["alias-route-missing"](agreeing()));
        expect(driftExitCode(found)).toBe(1);
        const both = compareDrift({
            ...cases["alias-route-missing"](agreeing()),
            dokku: { status: "unavailable", reason: "x" },
        });
        expect(driftExitCode(both)).toBe(2);
        const skipped = compareDrift({
            ...agreeing(),
            probe: { status: "skipped", reason: "none" },
        });
        expect(driftExitCode(skipped)).toBe(0);
    });

    it("treats an in-flight promotion as in flight, not as drift, and an expired dispatched lease as stuck", () => {
        const promoting: DriftOperation = {
            id: "op2",
            aliasId: "prod",
            status: "applying",
            leaseExpiresAt: FUTURE,
            dispatched: true,
        };
        const busy = withDb(agreeing(), {
            operations: [promoting],
            aliases: [alias({ state: "binding", reservedGeneration: 4n })],
        });
        // The router is still on the old generation, which would otherwise be "behind".
        const report = compareDrift(busy);
        expect(report.findings).toEqual([]);
        expect(report.inFlight).toContainEqual({ kind: "alias", id: "prod" });
        expect(
            codes(withDb(busy, { operations: [{ ...promoting, leaseExpiresAt: PAST }] })),
        ).toEqual(["stuck-operation"]);
        // A reconciliation-needed operation is stuck whatever its lease says.
        expect(
            codes(
                withDb(busy, {
                    operations: [
                        { ...promoting, status: "reconciliation-needed", leaseExpiresAt: null },
                    ],
                }),
            ),
        ).toEqual(["stuck-operation"]);
    });

    it("does not compare a deployment whose job is still running", () => {
        const base = agreeing();
        const input = withDb(base, {
            deployments: [...base.db.deployments, deployment("c", { status: "pending" })],
            reservations: [
                ...base.db.reservations,
                { hostname: "c-preview.sites.example.net", ownerKind: "deployment", ownerId: "c" },
            ],
        });
        expect(codes(input)).toEqual([]);
    });

    it("knows an app by retired history or a legacy record, and never by its name pattern", () => {
        const stray = { name: "lp-old", domains: [] as string[] };
        const dokku = {
            status: "ok",
            data: {
                apps: [...okApps(agreeing()), stray],
            },
        } as const;
        expect(codes({ ...agreeing(), dokku })).toEqual(["orphan-app"]);
        expect(codes(withDb({ ...agreeing(), dokku }, { knownAppNames: ["lp-old"] }))).toEqual([]);
    });

    it("compares generations above 2^53 exactly", () => {
        const big = 2n ** 60n;
        const input = routerWith(
            withDb(agreeing(), {
                aliases: [alias({ committedGeneration: big, reservedGeneration: big })],
            }),
            [
                {
                    hostname: "view-prod.sites.example.net",
                    generation: big + 1n,
                    operationId: "op1",
                    targetDeploymentId: "a",
                },
            ],
        );
        expect(codes(input)).toEqual(["alias-router-ahead"]);
        expect(compareDrift(input).findings[0]!.detail).toBe(`router ${big + 1n}, database ${big}`);
    });

    it("flags a withdrawn alias that the router still serves", () => {
        const input = withDb(agreeing(), {
            aliases: [alias({ state: "withdrawn", targetDeploymentId: null })],
            deployments: [
                deployment("a", { everPinned: true, lastUnpinnedAt: PAST }),
                deployment("b"),
            ],
        });
        // The router serves it (conflict) and a probe confirms it (the alias should serve nothing).
        expect(codes(input).toSorted()).toEqual(["alias-target-conflict", "probe-mismatch"]);
    });

    it("produces a report that serializes with identifiers only, and writes nothing", () => {
        const input = cases["alias-router-ahead"](agreeing());
        const before = JSON.stringify(input, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        const report = compareDrift(input);
        expect(JSON.stringify(input, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(
            before,
        );
        const text = JSON.stringify(report);
        expect(Object.keys(report.findings[0]!).toSorted()).toEqual([
            "action",
            "code",
            "detail",
            "resources",
            "severity",
        ]);
        expect(text).not.toMatch(/token|secret|password|env/i);
    });
});

describe("stableDrift", () => {
    const behind = (i: DriftInput) =>
        routerWith(i, [
            {
                hostname: "view-prod.sites.example.net",
                generation: 1n,
                operationId: "op0",
                targetDeploymentId: "a",
            },
        ]);

    it("keeps a finding both snapshots report, and drops it when its alias moved in between", () => {
        const input = behind(agreeing());
        expect(stableDrift(input, input.db).findings.map((f) => f.code)).toEqual([
            "alias-router-behind",
        ]);
        const moved = withDb(input, {
            aliases: [alias({ committedGeneration: 1n, reservedGeneration: 1n })],
        });
        expect(stableDrift(input, moved.db).findings).toEqual([]);
    });

    it("drops a probe finding caused by a promotion that landed between the snapshots", () => {
        // The probe already sees the new target (b); the earlier snapshot still expects a.
        const input: DriftInput = {
            ...agreeing(),
            probe: {
                status: "ok",
                data: { results: [{ hostname: "view-prod.sites.example.net", deploymentId: "b" }] },
            },
        };
        const after = withDb(input, {
            aliases: [
                alias({
                    targetDeploymentId: "b",
                    committedGeneration: 4n,
                    reservedGeneration: 4n,
                    lastOperationId: "op2",
                }),
            ],
        }).db;
        expect(compareDrift(input).findings.map((f) => f.code)).toContain("probe-mismatch");
        expect(stableDrift(input, after).findings.map((f) => f.code)).not.toContain(
            "probe-mismatch",
        );
    });

    it("drops an orphan-app finding for a deployment created between the snapshots", () => {
        const base = agreeing();
        const stray = { name: "lp-new", domains: ["new-preview.sites.example.net"] };
        const input: DriftInput = {
            ...base,
            dokku: { status: "ok", data: { apps: [...okApps(base), stray] } },
        };
        const created = deployment("new", { dokkuAppName: "lp-new", hostname: stray.domains[0]! });
        const after: DriftDatabase = {
            ...input.db,
            deployments: [...input.db.deployments, created],
            reservations: [
                ...input.db.reservations,
                { hostname: created.hostname, ownerKind: "deployment", ownerId: "new" },
            ],
        };
        expect(compareDrift(input).findings.map((f) => f.code)).toEqual(["orphan-app"]);
        expect(stableDrift(input, after).findings).toEqual([]);
    });

    it("drops a router-unknown-route finding for an alias created between the snapshots", () => {
        const base = agreeing();
        const input = routerWith(base, [
            ...(base.router.status === "ok" ? base.router.data.routes : []),
            {
                hostname: "view-new.sites.example.net",
                generation: 1n,
                operationId: "op9",
                targetDeploymentId: "a",
            },
        ]);
        const after = withDb(input, {
            aliases: [
                ...input.db.aliases,
                alias({
                    id: "new",
                    hostname: "view-new.sites.example.net",
                    committedGeneration: 1n,
                    reservedGeneration: 1n,
                    lastOperationId: "op9",
                }),
            ],
            reservations: [
                ...input.db.reservations,
                { hostname: "view-new.sites.example.net", ownerKind: "alias", ownerId: "new" },
            ],
        }).db;
        expect(compareDrift(input).findings.map((f) => f.code)).toEqual(["router-unknown-route"]);
        expect(stableDrift(input, after).findings).toEqual([]);
    });
});

describe("source and edge handling", () => {
    it.each([
        ["dokku", "deployment-app-missing"],
        ["router", "alias-route-missing"],
        ["archives", "archive-missing"],
        ["probe", "probe-mismatch"],
    ] as const)(
        "an unavailable %s source suppresses only its own findings (%s)",
        (source, code) => {
            const broken = cases[code](agreeing());
            expect(codes(broken)).toContain(code);
            const down = {
                ...broken,
                [source]: { status: "unavailable", reason: "down" },
            } as DriftInput;
            expect(codes(down)).not.toContain(code);
            expect(compareDrift(down).sources[source]).toBe("unavailable");
        },
    );

    it("treats a dispatched operation with no lease as stuck, and an undispatched queued one as in flight", () => {
        const base = withDb(agreeing(), {
            aliases: [alias({ state: "binding", reservedGeneration: 4n })],
        });
        const dispatched: DriftOperation = {
            id: "op2",
            aliasId: "prod",
            status: "applying",
            leaseExpiresAt: null,
            dispatched: true,
        };
        expect(codes(withDb(base, { operations: [dispatched] }))).toEqual(["stuck-operation"]);
        expect(
            codes(
                withDb(base, {
                    operations: [{ ...dispatched, status: "queued", dispatched: false }],
                }),
            ),
        ).toEqual([]);
    });

    it("is not fooled by a stateful /g pattern", () => {
        const input = agreeing();
        const apps = [
            ...okApps(input),
            { name: "lp-x1", domains: [] as string[] },
            { name: "lp-x2", domains: [] as string[] },
        ];
        const found = compareDrift({
            ...input,
            dokku: { status: "ok", data: { apps } },
            config: { ...input.config, appNamePattern: /^lp-[a-z0-9]+$/g },
        });
        expect(found.findings.map((f) => f.code)).toEqual(["orphan-app", "orphan-app"]);
    });

    it("expects an unbound or withdrawn alias to serve nothing when probed", () => {
        const input = withDb(agreeing(), {
            aliases: [
                alias({
                    state: "unbound",
                    targetDeploymentId: null,
                    committedGeneration: 0n,
                    reservedGeneration: 0n,
                }),
            ],
            deployments: [
                deployment("a", { everPinned: true, lastUnpinnedAt: PAST }),
                deployment("b"),
            ],
        });
        const served = routerWith(
            {
                ...input,
                probe: {
                    status: "ok",
                    data: {
                        results: [{ hostname: "view-prod.sites.example.net", deploymentId: "a" }],
                    },
                },
            },
            [],
        );
        expect(codes(served)).toEqual(["probe-mismatch"]);
    });
});
