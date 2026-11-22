import { promises as fs } from "node:fs";
import path from "node:path";
import { artifactStorageKey } from "@launchpad-kit/services";
import { SITE, tarGz, type FixtureEntry } from "@launchpad-kit/services/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildImage, sweepScratch } from "./build";
import { DeploymentEffectNotStarted } from "./deployment-errors";
import { createDocker } from "./docker";
import { dockerfile, imageTagFor, nginxConf } from "./template";
import { fakeDocker, LIMITS, tempDir } from "./testing";
import type { DeployContext } from "./types";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
let tmp: Awaited<ReturnType<typeof tempDir>>;
beforeEach(async () => {
    tmp = await tempDir();
});
afterEach(async () => {
    await tmp.cleanup();
});

async function setup(entries: FixtureEntry[], dockerBody: string, spa = false) {
    const digest = "a".repeat(64);
    const storageKey = artifactStorageKey("org-1", digest);
    const file = path.join(tmp.dir, storageKey);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, tarGz(entries));
    const seen = path.join(tmp.dir, "seen");
    // The stand-in "builds" by copying what it was given, so the test can look at it.
    const bin = await fakeDocker(
        tmp.dir,
        `ctx=$(eval echo \\$$#); mkdir -p '${seen}'; cp -r "$ctx/." '${seen}/'; ${dockerBody}`,
    );
    const context: DeployContext = {
        deploymentId: ID,
        appName: "lp-abcde12345",
        hostname: "demo.previews.example.com",
        spa,
        storageKey,
    };
    const deps = {
        dataDir: tmp.dir,
        limits: LIMITS,
        docker: createDocker({ binary: bin }),
        baseImage: "nginx:1.27-alpine",
    };
    return { context, deps, seen };
}
const signal = () => new AbortController().signal;

describe("building the image", () => {
    it("passes an operator-supplied digest pin through to Docker unchanged", async () => {
        const { context, deps, seen } = await setup(SITE, "exit 0");
        const baseImage = `nginx:1.27-alpine@sha256:${"b".repeat(64)}`;
        await buildImage(context, { ...deps, baseImage }, signal());
        const recipe = await fs.readFile(path.join(seen, "Dockerfile"), "utf8");
        expect(recipe.split("\n")[0]).toBe(`FROM ${baseImage}`);
    });

    it("hands docker exactly the fixed template, the site, and a unique tag", async () => {
        const { context, deps, seen } = await setup(SITE, "exit 0", true);
        expect(await buildImage(context, deps, signal())).toEqual({ imageTag: imageTagFor(ID) });
        expect(await fs.readFile(path.join(seen, "Dockerfile"), "utf8")).toBe(
            dockerfile("nginx:1.27-alpine"),
        );
        expect(await fs.readFile(path.join(seen, "nginx.conf"), "utf8")).toBe(
            nginxConf({ spa: true, deploymentId: ID }),
        );
        expect((await fs.readdir(path.join(seen, "site"))).toSorted()).toEqual([
            "assets",
            "index.html",
        ]);
        // Only those three: no other file from anywhere reaches the build context.
        expect((await fs.readdir(seen)).toSorted()).toEqual(["Dockerfile", "nginx.conf", "site"]);
    });

    it("leaves no scratch directory behind, whether it works or not", async () => {
        const good = await setup(SITE, "exit 0");
        await buildImage(good.context, good.deps, signal());
        expect(await fs.readdir(path.join(tmp.dir, "build"))).toEqual([]);
        const bad = await setup(SITE, "echo nope >&2; exit 1");
        await expect(buildImage(bad.context, bad.deps, signal())).rejects.toThrow(/build failed/);
        expect(await fs.readdir(path.join(tmp.dir, "build"))).toEqual([]);
    });

    it("never calls docker for an archive that no longer validates", async () => {
        const { context, deps, seen } = await setup(
            [...SITE, { name: "link", type: "symlink", link: "/etc/passwd" }],
            "exit 0",
        );
        await expect(buildImage(context, deps, signal())).rejects.toBeInstanceOf(
            DeploymentEffectNotStarted,
        );
        await expect(fs.stat(seen)).rejects.toThrow();
        expect(await fs.readdir(path.join(tmp.dir, "build"))).toEqual([]);
    });

    it("refuses a storage key that is not one this system wrote", async () => {
        const { context, deps } = await setup(SITE, "exit 0");
        const build = buildImage({ ...context, storageKey: "../../etc/passwd" }, deps, signal());
        await expect(build).rejects.toBeInstanceOf(DeploymentEffectNotStarted);
        await expect(build).rejects.toMatchObject({
            cause: expect.objectContaining({ message: "Not an artifact storage key." }),
        });
    });
});

describe("sweeping abandoned build directories", () => {
    it("removes only old b-* directories, and nothing else", async () => {
        const root = path.join(tmp.dir, "build");
        await fs.mkdir(root, { recursive: true });
        const old = path.join(root, "b-abc123");
        const young = path.join(root, "b-xyz789");
        const other = path.join(root, "keep-me");
        for (const dir of [old, young, other])
            await fs.mkdir(path.join(dir, "site"), { recursive: true });
        const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
        await fs.utimes(old, past, past);
        await fs.utimes(other, past, past);
        expect(await sweepScratch(tmp.dir)).toBe(1);
        expect((await fs.readdir(root)).toSorted()).toEqual(["b-xyz789", "keep-me"]);
        expect(await sweepScratch(path.join(tmp.dir, "missing"))).toBe(0);
    });
});
