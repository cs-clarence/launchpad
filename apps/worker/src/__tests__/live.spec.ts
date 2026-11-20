import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { createDokkuClient, type DokkuClient } from "@launchpad-kit/dokku";
import { artifactStorageKey } from "@launchpad-kit/services";
import { tarGz, type FixtureEntry } from "@launchpad-kit/services/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDocker } from "../docker";
import type { DeploymentRunnerPorts } from "../deployment-runner";
import { createLifecyclePorts } from "../lifecycle-ports";
import { createDeployPorts } from "../ports";
import type { DeployContext } from "../types";
import { compactId, imageTagFor } from "../template";

// LIVE TESTS. They talk to a real Dokku and a real Docker engine, so they are an
// explicit opt-in: `omni -i run test:live -p @launchpad-kit/worker`, never part of `test`
// or CI.
//
// What they touch: only apps named `lp-test-<6 letters or digits>` that they create
// themselves, which they record and destroy at the end (and never any other app, so
// never a demo or a real preview). Point them at a DISPOSABLE Dokku you started
// yourself, and set:
//
//   LAUNCHPAD_LIVE_DOKKU=1                 you confirm the Dokku is disposable
//   DOKKU_SSH_HOST / _PORT / _USER         the Dokku host
//   DOKKU_SSH_KEY_PATH                     private key (mode 600)
//   DOKKU_SSH_KNOWN_HOSTS_PATH             host key pinned out of band
//   LAUNCHPAD_LIVE_PROXY_URL               where this machine reaches Dokku's proxy
//   LAUNCHPAD_LIVE_DOMAIN                  a domain for the test hostnames (default
//                                          live.example.com; no DNS is needed)
//   DOCKER_HOST                            the Docker engine the worker builds with

const env = process.env;
const missing = [
    "LAUNCHPAD_LIVE_DOKKU",
    "DOKKU_SSH_HOST",
    "DOKKU_SSH_KEY_PATH",
    "DOKKU_SSH_KNOWN_HOSTS_PATH",
    "LAUNCHPAD_LIVE_PROXY_URL",
].filter((name) => !env[name]);
if (missing.length > 0) {
    throw new Error(
        `The live tests need ${missing.join(", ")}. They talk to a real Dokku and Docker; ` +
            "read the header of src/__tests__/live.spec.ts, and use a disposable Dokku.",
    );
}
if (env.LAUNCHPAD_LIVE_DOKKU !== "1") {
    throw new Error("Set LAUNCHPAD_LIVE_DOKKU=1 to confirm the Dokku is disposable.");
}

const PREFIX = "lp-test-";
const APP_PATTERN = /^lp-test-[a-z0-9]{6}$/;
const domain = env.LAUNCHPAD_LIVE_DOMAIN || "live.example.com";
const proxy = new URL(env.LAUNCHPAD_LIVE_PROXY_URL!);

const SITE_FILES: FixtureEntry[] = [
    { name: "index.html", content: "<!doctype html><title>live fixture</title><p>hello</p>" },
    { name: "app.js", content: "console.log('live')" },
    { name: "assets/", type: "dir" },
    { name: "assets/logo.svg", content: "<svg xmlns='http://www.w3.org/2000/svg'/>" },
];

let dataDir = "";
let dokku: DokkuClient;
let ports: DeploymentRunnerPorts;
const docker = createDocker({ binary: env.LAUNCHPAD_DOCKER_BIN || "docker" });
const created = new Set<string>();
const images = new Set<string>();

function suffix(): string {
    return [...randomBytes(6)].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}

async function newRelease(spa: boolean, app: string): Promise<DeployContext> {
    const deploymentId = randomUUID();
    const digest = randomBytes(32).toString("hex");
    const storageKey = artifactStorageKey("live-org", digest);
    const file = path.join(dataDir, storageKey);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, tarGz(SITE_FILES));
    return { deploymentId, appName: app, hostname: `${app}.${domain}`, spa, storageKey };
}

// The same steps the state machine runs, in the same order.
async function deploy(context: DeployContext) {
    if (!context.appName.startsWith(PREFIX)) throw new Error("Refusing a non-test app.");
    const signal = new AbortController().signal;
    if (!created.has(context.appName)) {
        // A name that already exists was not made by this run: never adopt, change or
        // destroy it. It is recorded before the create, so even a create that ends
        // uncertain (but did happen) is cleaned up.
        if (await dokku.apps.exists(context.appName, signal)) {
            throw new Error(`${context.appName} already exists; refusing to use it.`);
        }
        created.add(context.appName);
        await dokku.apps.create(context.appName, signal);
    }
    images.add(imageTagFor(context.deploymentId));
    const image = await ports.build(context, signal);
    await ports.setDomain(context.appName, context.hostname, signal);
    await ports.setPort(context.appName, signal);
    await ports.load(context, image, signal);
    await ports.verify(context, signal);
}

function get(
    host: string,
    urlPath: string,
): Promise<{ status: number; body: string; id?: string }> {
    return new Promise((resolve, reject) => {
        const secure = proxy.protocol === "https:";
        // The same transport the worker's readiness probe uses, so an HTTPS-only proxy
        // is exercised the same way: its protocol, its default port, and the preview's
        // name as both Host and TLS server name.
        const request = (secure ? https : http).request(
            {
                hostname: proxy.hostname,
                port: proxy.port || (secure ? 443 : 80),
                path: urlPath,
                headers: { Host: host },
                timeout: 10_000,
                ...(secure ? { servername: host } : {}),
            },
            (response) => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => (body += chunk));
                response.on("end", () =>
                    resolve({
                        status: response.statusCode ?? 0,
                        body,
                        id: response.headers["x-launchpad-deployment"] as string | undefined,
                    }),
                );
            },
        );
        request.on("error", reject);
        request.on("timeout", () => request.destroy(new Error("timed out")));
        request.end();
    });
}

beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-live-"));
    dokku = createDokkuClient(
        {
            host: env.DOKKU_SSH_HOST!,
            port: Number(env.DOKKU_SSH_PORT || 22),
            username: env.DOKKU_SSH_USER || "dokku",
            privateKeyPath: env.DOKKU_SSH_KEY_PATH!,
            knownHostsPath: env.DOKKU_SSH_KNOWN_HOSTS_PATH!,
        },
        { appNamePattern: APP_PATTERN },
    );
    ports = createDeployPorts({
        dokku,
        docker,
        dataDir,
        limits: { maxExpandedBytes: 10 * 1024 * 1024, maxEntries: 100, maxDepth: 8 },
        baseImage: env.LAUNCHPAD_BASE_IMAGE || "nginx:1.27-alpine",
        probe: { proxyUrl: proxy, timeoutMs: 120_000, intervalMs: 2000 },
    });
});

// Only apps this run created, and only by names that match the test pattern.
afterAll(async () => {
    for (const app of created) {
        if (APP_PATTERN.test(app)) await dokku.apps.destroy(app).catch(() => undefined);
    }
    for (const tag of images) await docker.removeImage(tag).catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
});

describe("a static preview on a real Dokku", () => {
    it("serves the fixture, and an unknown path is a real 404", async () => {
        const app = `${PREFIX}${suffix()}`;
        const release = await newRelease(false, app);
        await deploy(release);
        const root = await get(release.hostname, "/");
        expect(root.status).toBe(200);
        expect(root.body).toContain("live fixture");
        expect(root.id).toBe(compactId(release.deploymentId));
        expect((await get(release.hostname, "/assets/logo.svg")).status).toBe(200);
        expect((await get(release.hostname, "/dashboard/settings")).status).toBe(404);
    });

    it("with spa on, a deep link serves index.html with 200", async () => {
        const app = `${PREFIX}${suffix()}`;
        const release = await newRelease(true, app);
        await deploy(release);
        const deep = await get(release.hostname, "/dashboard/settings");
        expect(deep.status).toBe(200);
        expect(deep.body).toContain("live fixture");
    });

    it("keeps two deployments serving at independent hostnames", async () => {
        const first = await newRelease(false, `${PREFIX}${suffix()}`);
        await deploy(first);
        expect((await get(first.hostname, "/")).id).toBe(compactId(first.deploymentId));

        const second = await newRelease(false, `${PREFIX}${suffix()}`);
        await deploy(second);
        expect((await get(second.hostname, "/")).id).toBe(compactId(second.deploymentId));

        expect((await get(first.hostname, "/")).id).toBe(compactId(first.deploymentId));
    });
});

// Deleting is the destructive half, so it is checked against the real host with care: the
// only app destroyed is one this run created, through the same ports a deletion uses, and
// a neighbouring app made by this run must still be there afterwards.
describe("deleting a preview's app on a real Dokku", () => {
    it("destroys exactly the named app, asks before it acts, and leaves a neighbour alone", async () => {
        const lifecycle = createLifecyclePorts({
            dokku,
            docker: createDocker({ binary: env.LAUNCHPAD_DOCKER_BIN || "docker" }),
        });
        const signal = new AbortController().signal;
        const target = `${PREFIX}${suffix()}`;
        const neighbour = `${PREFIX}${suffix()}`;
        for (const app of [target, neighbour]) {
            if (await dokku.apps.exists(app, signal))
                throw new Error(`${app} already exists; refusing to use it.`);
            created.add(app);
            await dokku.apps.create(app, signal);
        }
        expect(await lifecycle.dokku.apps.exists(target, signal)).toBe(true);
        await lifecycle.dokku.apps.destroy(target, signal);
        expect(await lifecycle.dokku.apps.exists(target, signal)).toBe(false);
        // Asking again, as a retry after a lost answer would, finds it gone.
        expect(await lifecycle.dokku.apps.exists(target, signal)).toBe(false);
        expect(await lifecycle.dokku.apps.exists(neighbour, signal)).toBe(true);
    });

    it("refuses an app name outside the guarded test pattern, so a real preview or the demo cannot be reached", async () => {
        const lifecycle = createLifecyclePorts({
            dokku,
            docker: createDocker({ binary: env.LAUNCHPAD_DOCKER_BIN || "docker" }),
        });
        for (const name of [
            "view-demo",
            "lp-abcdefghij",
            "lp-test-ab",
            `${PREFIX}${suffix()};ls`,
        ]) {
            // Refused locally, before anything is sent: the error is the validator's.
            await expect(lifecycle.dokku.apps.destroy(name), name).rejects.toMatchObject({
                kind: "invalid-argument",
                operation: "apps:destroy",
            });
        }
    });
});
