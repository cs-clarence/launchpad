import { DokkuError, type DokkuClient } from "@launchpad/dokku";
import type { DeployContext } from "@launchpad/services";
import { describe, expect, it } from "vitest";
import { createDocker, DockerError, type Docker } from "./docker";
import { createDeployPorts } from "./ports";
import { fakeDocker, LIMITS, tempDir } from "./testing";

const context: DeployContext = {
    deploymentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    appName: "lp-abcde12345",
    hostname: "demo.previews.example.com",
    spa: false,
    storageKey: "x",
};
const TAG = "launchpad/site:0f8fad5bd9cb469fa16570867728950e";

function setup(options: { loadFails?: boolean; saveFails?: boolean } = {}) {
    const events: string[] = [];
    const dokku = {
        apps: {},
        domains: {},
        ports: {},
        git: {
            loadImage: async (app: string, tag: string, archive: AsyncIterable<Uint8Array>) => {
                events.push(`load ${app} ${tag}`);
                for await (const _ of archive) {
                    // consumed
                }
                if (options.loadFails) {
                    throw new DokkuError({
                        kind: "failed",
                        operation: "git:load-image",
                        message: "x",
                    });
                }
            },
        },
    } as unknown as DokkuClient;
    const docker = {
        save: () => ({
            stream: (async function* () {
                yield Buffer.from("tar");
            })(),
            done: options.saveFails
                ? Promise.reject(new DockerError("Saving the image failed.", ""))
                : Promise.resolve(),
        }),
        remove: async (tag: string) => {
            events.push(`remove ${tag}`);
        },
    } as unknown as Docker;
    const ports = createDeployPorts({
        dokku,
        docker,
        dataDir: "/tmp",
        limits: LIMITS,
        baseImage: "nginx:1.27-alpine",
        probe: { proxyUrl: new URL("http://127.0.0.1:1"), timeoutMs: 100, intervalMs: 20 },
    });
    return { ports, events };
}

describe("loading the image", () => {
    it("streams the save to this app and removes the local image afterwards", async () => {
        const { ports, events } = setup();
        await ports.loadImage(context, TAG, new AbortController().signal);
        expect(events).toEqual([`load lp-abcde12345 ${TAG}`, `remove ${TAG}`]);
    });

    it("reports Dokku's own failure, and still removes the image", async () => {
        const { ports, events } = setup({ loadFails: true });
        await expect(
            ports.loadImage(context, TAG, new AbortController().signal),
        ).rejects.toBeInstanceOf(DokkuError);
        expect(events.at(-1)).toBe(`remove ${TAG}`);
    });

    it("fails when docker save failed even though Dokku accepted the stream", async () => {
        const { ports } = setup({ saveFails: true });
        await expect(
            ports.loadImage(context, TAG, new AbortController().signal),
        ).rejects.toBeInstanceOf(DockerError);
    });
});

describe("when Dokku refuses before reading the image", () => {
    it("stops docker save at once instead of waiting for its pipe to drain", async () => {
        const tmp = await tempDir();
        try {
            // Plenty of output and nothing reading it, so it blocks. `exec` makes the process
            // that holds the pipe the one that receives the stop signal.
            const bin = await fakeDocker(
                tmp.dir,
                `case "$1" in save) exec head -c 20000000 /dev/zero;; *) exit 0;; esac`,
            );
            const dokku = {
                git: {
                    loadImage: async () => {
                        throw new DokkuError({
                            kind: "trust",
                            operation: "connect",
                            message: "no",
                        });
                    },
                },
            } as unknown as DokkuClient;
            const ports = createDeployPorts({
                dokku,
                docker: createDocker({ binary: bin }),
                dataDir: tmp.dir,
                limits: LIMITS,
                baseImage: "nginx:1.27-alpine",
                probe: { proxyUrl: new URL("http://127.0.0.1:1"), timeoutMs: 100, intervalMs: 20 },
            });
            const started = Date.now();
            await expect(
                ports.loadImage(context, TAG, new AbortController().signal),
            ).rejects.toBeInstanceOf(DokkuError);
            expect(Date.now() - started).toBeLessThan(8000);
        } finally {
            await tmp.cleanup();
        }
    });
});
