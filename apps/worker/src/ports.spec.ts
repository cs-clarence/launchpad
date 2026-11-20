import { DokkuError, type DokkuClient } from "@launchpad-kit/dokku";
import { describe, expect, it } from "vitest";
import { createDocker, DockerError, type Docker } from "./docker";
import { createDeployPorts } from "./ports";
import { fakeDocker, LIMITS, tempDir } from "./testing";
import type { DeployContext } from "./types";

const context: DeployContext = {
    deploymentId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    appName: "lp-abcde12345",
    hostname: "demo.previews.example.com",
    spa: false,
    storageKey: "x",
};
const TAG = "launchpad/site:0f8fad5bd9cb469fa16570867728950e";
const IMAGE = { imageTag: TAG, imageId: `sha256:${"a".repeat(64)}` };

function setup(options: { loadFails?: boolean; saveFails?: boolean; imageId?: string } = {}) {
    const events: string[] = [];
    const dokku = {
        apps: {},
        domains: {},
        ports: { set: async () => {} },
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
        imageId: async () => options.imageId ?? IMAGE.imageId,
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
    it("streams the recorded image to this app and leaves cleanup to deletion", async () => {
        const { ports, events } = setup();
        await ports.load(context, IMAGE, new AbortController().signal);
        expect(events).toEqual([`load lp-abcde12345 ${TAG}`]);
    });

    it("reports Dokku's own failure without removing the image", async () => {
        const { ports, events } = setup({ loadFails: true });
        await expect(
            ports.load(context, IMAGE, new AbortController().signal),
        ).rejects.toBeInstanceOf(DokkuError);
        expect(events).toEqual([`load lp-abcde12345 ${TAG}`]);
    });

    it("fails when docker save failed even though Dokku accepted the stream", async () => {
        const { ports } = setup({ saveFails: true });
        await expect(
            ports.load(context, IMAGE, new AbortController().signal),
        ).rejects.toBeInstanceOf(DockerError);
    });

    it("refuses to load an unrecorded image or a tag from another deployment", async () => {
        const { ports, events } = setup({ imageId: `sha256:${"b".repeat(64)}` });
        const signal = new AbortController().signal;
        await expect(ports.load(context, IMAGE, signal)).rejects.toThrow(/recorded image/);
        await expect(
            ports.load(
                { ...context, deploymentId: "5359f724-19f4-4caf-a002-d58796c6bd75" },
                IMAGE,
                signal,
            ),
        ).rejects.toThrow(/recorded image/);
        expect(events).toEqual([]);
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
                `case "$1" in image) echo '${IMAGE.imageId}';; save) exec head -c 20000000 /dev/zero;; esac`,
            );
            const dokku = {
                apps: {},
                domains: {},
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
                ports.load(context, IMAGE, new AbortController().signal),
            ).rejects.toBeInstanceOf(DokkuError);
            expect(Date.now() - started).toBeLessThan(8000);
        } finally {
            await tmp.cleanup();
        }
    });
});
