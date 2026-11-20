import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DokkuClient } from "@launchpad-kit/dokku";
import type { DriftDatabase, DriftDeployment, DriftReport } from "@launchpad-kit/services";
import {
    collectDrift,
    driftCommandExitCode,
    readDriftArchives,
    readDriftDokku,
    readDriftRouter,
} from "./drift";

const key = `artifacts/${"a".repeat(32)}/${"b".repeat(64)}.tar.gz`;
const deployment: DriftDeployment = {
    id: "deployment",
    organizationId: "org",
    appId: "app",
    dokkuAppName: "lp-abcde12345",
    hostname: "d.example.net",
    status: "succeeded",
    referencedByAliasIds: [],
    inUncertainChain: false,
    everPinned: false,
    lastUnpinnedAt: null,
    artifactKey: key,
};
const database = (deployments: DriftDeployment[] = [deployment]): DriftDatabase => ({
    deployments,
    aliases: [],
    operations: [],
    reservations: deployments.map((d) => ({
        hostname: d.hostname,
        ownerKind: "deployment",
        ownerId: d.id,
    })),
    legacyPreviewIds: [],
    knownAppNames: [],
});
const config = { expectedEpoch: "epoch", now: new Date(), appNamePattern: /^lp-[a-z0-9]{10}$/ };
let dir: string | undefined;
afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = undefined;
});

describe("read-only drift collection", () => {
    it("reads the database twice and drops a missing-app finding when it retires during the read", async () => {
        let reads = 0;
        const report = await collectDrift({
            database: async () =>
                database([{ ...deployment, status: ++reads === 1 ? "succeeded" : "retired" }]),
            dokku: async () => ({ apps: [] }),
            archives: async () => ({ keys: [key] }),
            config,
        });
        expect(reads).toBe(2);
        expect(report.findings).toEqual([]);
        expect(report.sources).toEqual({
            dokku: "ok",
            router: "skipped",
            probe: "skipped",
            archives: "ok",
        });
        expect(driftCommandExitCode(report)).toBe(0);
    });

    it("never reports a failed requested source as an empty or skipped inventory", async () => {
        const report = await collectDrift({
            database: async () => database(),
            dokku: async () => {
                throw new Error("secret remote output");
            },
            router: async () => {
                throw new Error("token=secret");
            },
            probe: async () => {
                throw new Error("unreachable");
            },
            archives: async () => {
                throw new Error("permission denied");
            },
            config,
        });
        expect(Object.values(report.sources)).toEqual([
            "unavailable",
            "unavailable",
            "unavailable",
            "unavailable",
        ]);
        expect(report.findings).toEqual([]);
        expect(driftCommandExitCode(report)).toBe(2);
        expect(JSON.stringify(report)).not.toContain("secret");
    });

    it("propagates either failed database snapshot rather than producing a partial report", async () => {
        for (const failOn of [1, 2]) {
            let reads = 0;
            await expect(
                collectDrift({
                    database: async () => {
                        if (++reads === failOn) throw new Error("database down");
                        return database([]);
                    },
                    archives: async () => ({ keys: [] }),
                    config,
                }),
            ).rejects.toThrow("database down");
        }
    });

    it("returns findings, with requested-source unavailability taking precedence", () => {
        const report: DriftReport = {
            sources: { dokku: "ok", router: "skipped", archives: "ok", probe: "skipped" },
            findings: [
                { code: "orphan-app", severity: "medium", resources: [], action: "Investigate." },
            ],
            inFlight: [],
            ignoredAppCount: 0,
        };
        expect(driftCommandExitCode(report)).toBe(1);
        expect(
            driftCommandExitCode({
                ...report,
                sources: { ...report.sources, router: "unavailable" },
            }),
        ).toBe(2);
    });
});

describe("source readers", () => {
    it("queries domains only for generated app names and retains unrelated names for ignored counts", async () => {
        const domains: string[] = [];
        const client = {
            apps: { list: async () => ["lp-abcde12345", "other-site"] },
            domains: {
                report: async (name: string) => {
                    domains.push(name);
                    return ["d.example.net"];
                },
            },
        } as unknown as DokkuClient;
        expect(await readDriftDokku(client)).toEqual({
            apps: [
                { name: "lp-abcde12345", domains: ["d.example.net"] },
                { name: "other-site", domains: [] },
            ],
        });
        expect(domains).toEqual(["lp-abcde12345"]);
    });

    it("fails the entire Dokku inventory if even one domain read fails", async () => {
        const client = {
            apps: { list: async () => ["lp-abcde12345"] },
            domains: {
                report: async () => {
                    throw new Error("lost connection");
                },
            },
        } as unknown as DokkuClient;
        await expect(readDriftDokku(client)).rejects.toThrow("lost connection");
    });

    it("retains tombstones and exact bigint generations from the checked router inventory", async () => {
        const result = await readDriftRouter({
            epoch: async () => "epoch",
            withdraw: async () => {
                throw new Error("must not write");
            },
            view: async () => ({
                instanceId: "instance",
                epoch: "epoch",
                routes: [
                    {
                        aliasId: "alias",
                        hostname: "a.example.net",
                        operationId: "operation",
                        generation: "9007199254740993",
                        target: null,
                    },
                ],
            }),
        });
        expect(result).toEqual({
            epoch: "epoch",
            routes: [
                {
                    hostname: "a.example.net",
                    operationId: "operation",
                    generation: 9007199254740993n,
                    targetDeploymentId: null,
                    targetHostname: null,
                },
            ],
        });
    });

    it("distinguishes missing archives from an unavailable mount without creating directories", async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "drift-archives-"));
        expect(await readDriftArchives(dir, database())).toEqual({ keys: [] });
        expect(await fs.readdir(dir)).toEqual([]);
        await fs.mkdir(path.dirname(path.join(dir, key)), { recursive: true });
        await fs.writeFile(path.join(dir, key), "archive");
        expect(await readDriftArchives(dir, database())).toEqual({ keys: [key] });
        await expect(
            readDriftArchives(path.join(dir, "missing-mount"), database()),
        ).rejects.toThrow("unavailable");
    });

    it("refuses linked archives and directory components and invalid stored keys", async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "drift-archives-"));
        await fs.mkdir(path.dirname(path.join(dir, key)), { recursive: true });
        await fs.writeFile(path.join(dir, "outside"), "archive");
        await fs.symlink(path.join(dir, "outside"), path.join(dir, key));
        await expect(readDriftArchives(dir, database())).rejects.toThrow("Linked");
        await fs.unlink(path.join(dir, key));
        await fs.rmdir(path.dirname(path.join(dir, key)));
        await fs.symlink(dir, path.dirname(path.join(dir, key)));
        await expect(readDriftArchives(dir, database())).rejects.toThrow("Linked");
        await expect(
            readDriftArchives(dir, database([{ ...deployment, artifactKey: "../outside" }])),
        ).rejects.toThrow("storage key");
    });
});
