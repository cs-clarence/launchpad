import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { DokkuClient } from "@launchpad-kit/dokku";
import { artifactStorageKey } from "@launchpad-kit/services";
import { SITE, tarGz } from "@launchpad-kit/services/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDocker } from "./docker";
import { createDeployPorts } from "./ports";
import type { DeployContext } from "./types";
import { compactId, imageTagFor, nginxConf } from "./template";
import { fakeDocker, LIMITS, tempDir } from "./testing";

const NEW_ID = "11111111-1111-4111-8111-111111111111";
const OLD_ID = "22222222-2222-4222-8222-222222222222";
let tmp: Awaited<ReturnType<typeof tempDir>>;
let server: http.Server;
let proxy: URL;
let stamp = compactId(OLD_ID);
let hosts: (string | undefined)[] = [];

beforeAll(async () => {
    tmp = await tempDir();
    server = http.createServer((req, res) => {
        hosts.push(req.headers.host);
        res.writeHead(200, { "X-Launchpad-Deployment": stamp });
        res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    proxy = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});
afterAll(async () => {
    await tmp.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("restoring the previous release", () => {
    it("rebuilds it from its own artifact, loads it, and requires its own id to be serving", async () => {
        const storageKey = artifactStorageKey("org-1", "b".repeat(64));
        const file = path.join(tmp.dir, storageKey);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, tarGz(SITE));
        const seen = path.join(tmp.dir, "seen");
        const bin = await fakeDocker(
            tmp.dir,
            `case "$1" in build) ctx=$(eval echo \\$$#); mkdir -p '${seen}'; cp -r "$ctx/." '${seen}/';; save) printf TAR;; esac`,
        );
        const loaded: string[] = [];
        const dokku = {
            git: {
                loadImage: async (app: string, tag: string, archive: AsyncIterable<Uint8Array>) => {
                    for await (const _ of archive) {
                        // consumed
                    }
                    loaded.push(`${app} ${tag}`);
                },
            },
        } as unknown as DokkuClient;
        const ports = createDeployPorts({
            dokku,
            docker: createDocker({ binary: bin }),
            dataDir: tmp.dir,
            limits: LIMITS,
            baseImage: "nginx:1.27-alpine",
            probe: { proxyUrl: proxy, timeoutMs: 400, intervalMs: 50 },
        });
        const base = {
            appName: "lp-abcde12345",
            hostname: "demo.previews.example.com",
            storageKey,
        };
        const failed: DeployContext = { ...base, deploymentId: NEW_ID, spa: false };
        const previous: DeployContext = { ...base, deploymentId: OLD_ID, spa: true };
        const signal = new AbortController().signal;

        await ports.rollback(failed, previous, signal);
        // It is the previous release that was built (its id and its SPA setting), loaded
        // into this preview's app, and probed through this preview's hostname.
        expect(await fs.readFile(path.join(seen, "nginx.conf"), "utf8")).toBe(
            nginxConf({ spa: true, deploymentId: OLD_ID }),
        );
        expect(loaded).toEqual([`lp-abcde12345 ${imageTagFor(OLD_ID)}`]);
        expect(hosts.at(-1)).toBe("demo.previews.example.com");

        // If the failed release is still the one answering, the rollback has not worked.
        stamp = compactId(NEW_ID);
        await expect(ports.rollback(failed, previous, signal)).rejects.toThrow(/ready/);
        stamp = compactId(OLD_ID);
    });
});
