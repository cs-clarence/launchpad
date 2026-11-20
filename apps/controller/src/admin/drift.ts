import { constants, promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { DEFAULT_APP_NAME, type DokkuClient } from "@launchpad-kit/dokku";
import {
    resolveArtifactPath,
    driftExitCode,
    stableDrift,
    toDriftRouter,
    type ArchiveRead,
    type DokkuRead,
    type DriftConfig,
    type DriftDatabase,
    type DriftReport,
    type ProbeRead,
    type RouterRead,
    type SourceRead,
} from "@launchpad-kit/services";
import type { RouterSession } from "./router-view";

type Reader<T> = () => Promise<T>;

async function source<T>(read: Reader<T> | undefined): Promise<SourceRead<T>> {
    if (!read) return { status: "skipped", reason: "Not requested." };
    try {
        return { status: "ok", data: await read() };
    } catch {
        // No raw SSH output, filesystem paths, credentials or transport errors in reports.
        return {
            status: "unavailable",
            reason: "The requested source could not be read completely.",
        };
    }
}

export async function collectDrift(options: {
    database: Reader<DriftDatabase>;
    dokku?: Reader<DokkuRead>;
    router?: Reader<RouterRead>;
    archives: (db: DriftDatabase) => Promise<ArchiveRead>;
    probe?: (db: DriftDatabase) => Promise<ProbeRead>;
    config: DriftConfig;
}): Promise<DriftReport> {
    const before = await options.database();
    const [dokku, router, archives, probe] = await Promise.all([
        source(options.dokku),
        source(options.router),
        source(() => options.archives(before)),
        source(options.probe ? () => options.probe!(before) : undefined),
    ]);
    const after = await options.database();
    return stableDrift(
        { db: before, dokku, router, archives, probe, config: options.config },
        after,
    );
}

export async function readDriftDokku(client: DokkuClient): Promise<DokkuRead> {
    const signal = AbortSignal.timeout(120_000);
    const names = await client.apps.list(signal);
    const apps: DokkuRead["apps"][number][] = [];
    for (const name of names) {
        signal.throwIfAborted();
        apps.push({
            name,
            domains: DEFAULT_APP_NAME.test(name) ? await client.domains.report(name, signal) : [],
        });
    }
    return { apps };
}

export async function readDriftRouter(session: RouterSession): Promise<RouterRead> {
    return toDriftRouter(await session.view());
}

async function present(file: string, directory = false): Promise<boolean> {
    try {
        const stat = await fs.lstat(file);
        // A link is never followed, even if its target looks like an archive.
        if (stat.isSymbolicLink()) throw new Error("Linked archive path.");
        return directory ? stat.isDirectory() : stat.isFile();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

export async function readDriftArchives(dataDir: string, db: DriftDatabase): Promise<ArchiveRead> {
    if (!(await present(dataDir, true))) throw new Error("Archive storage is unavailable.");
    const keys = [...new Set(db.deployments.map((d) => d.artifactKey).filter((k) => k !== null))];
    const stored: string[] = [];
    for (const key of keys) {
        const file = resolveArtifactPath(dataDir, key);
        if (
            (await present(path.join(dataDir, "artifacts"), true)) &&
            (await present(path.dirname(file), true)) &&
            (await present(file))
        ) {
            // An inaccessible archive is unavailable, not missing.
            const handle = await fs.open(
                file,
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
                if (!(await handle.stat()).isFile()) throw new Error("Not a regular archive.");
            } finally {
                await handle.close();
            }
            stored.push(key);
        }
    }
    return { keys: stored };
}

function probeOrigin(value: string | undefined): URL {
    if (!value) throw new Error("Probe origin is required.");
    const url = new URL(value);
    if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
    )
        throw new Error("Invalid probe origin.");
    return url;
}

function identity(
    url: URL,
    hostname: string,
    signal: AbortSignal,
    requireFixed404 = false,
): Promise<string | null> {
    return new Promise((resolve, reject) => {
        const request = (url.protocol === "https:" ? https : http).request(
            {
                hostname: url.hostname.replace(/^\[|\]$/g, ""),
                port: url.port || undefined,
                path: "/",
                method: "GET",
                headers: { Host: hostname, Connection: "close" },
                ...(url.protocol === "https:" ? { servername: hostname } : {}),
                signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
            },
            (response) => {
                const header = response.headers["x-launchpad-deployment"];
                response.destroy();
                if (response.statusCode === 404 && (!requireFixed404 || header === undefined))
                    return resolve(null);
                if (response.statusCode !== 200) return reject(new Error("Probe unavailable."));
                if (header === undefined) {
                    if (requireFixed404)
                        return reject(
                            new Error("Probe did not verify a deployment or withdrawal."),
                        );
                    return resolve(null);
                }
                if (typeof header !== "string" || !/^[0-9a-f]{32}$/.test(header)) {
                    return reject(new Error("Invalid probe identity."));
                }
                resolve(
                    `${header.slice(0, 8)}-${header.slice(8, 12)}-${header.slice(12, 16)}-${header.slice(16, 20)}-${header.slice(20)}`,
                );
            },
        );
        request.on("error", reject);
        request.end();
    });
}

export function readRepublishProbe(value: string | undefined, hostname: string) {
    return identity(probeOrigin(value), hostname, AbortSignal.timeout(5000), true);
}

// Uses configured proxy origins, not uploaded content or per-record target URLs.
// Never follows a redirect. The response body is discarded immediately.
export async function readDriftProbes(
    env: Record<string, string | undefined>,
    db: DriftDatabase,
    recovery = false,
): Promise<ProbeRead> {
    const signal = AbortSignal.timeout(120_000);
    const targets = [
        ...db.deployments
            .filter(
                (d) =>
                    d.status !== "pending" &&
                    d.status !== "retired" &&
                    (d.status === "succeeded" ||
                        d.referencedByAliasIds.length > 0 ||
                        d.inUncertainChain),
            )
            .map((d) => ({
                hostname: d.hostname,
                origin: env.LAUNCHPAD_APPS_PROXY_URL,
            })),
        ...db.aliases
            .filter((a) => recovery || ["bound", "unbound", "withdrawn"].includes(a.state))
            .map((a) => ({
                hostname: a.hostname,
                origin: env.LAUNCHPAD_ALIAS_PROBE_URL,
            })),
    ];
    const results: ProbeRead["results"][number][] = [];
    for (const target of targets) {
        results.push({
            hostname: target.hostname,
            deploymentId: await identity(
                probeOrigin(target.origin),
                target.hostname,
                signal,
                recovery,
            ),
        });
    }
    return { results };
}

// Skipping a source is explicit and remains visible in the report; it is not an
// unavailable requested source. The probe is optional in the approved P5b contract.
export function driftCommandExitCode(report: DriftReport): 0 | 1 | 2 {
    const code = driftExitCode(report);
    return code === 3 ? 0 : code;
}
