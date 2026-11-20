import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DeploymentEffectNotStarted } from "./deployment-errors";
import { createDocker, DockerError } from "./docker";
import { fakeDocker, tempDir } from "./testing";

let tmp: Awaited<ReturnType<typeof tempDir>>;
beforeAll(async () => {
    tmp = await tempDir();
});
afterAll(async () => {
    await tmp.cleanup();
});

const TAG = "launchpad/site:0f8fad5bd9cb469fa16570867728950e";

async function recording(body = "") {
    const argv = path.join(tmp.dir, `argv-${Math.random().toString(16).slice(2)}`);
    const env = `${argv}.env`;
    const bin = await fakeDocker(
        tmp.dir,
        `printf '%s\\n' "$@" > '${argv}'; env | sort > '${env}'; ${body}`,
    );
    return { docker: createDocker({ binary: bin }), argv, env };
}
const lines = async (file: string) => (await fs.readFile(file, "utf8")).trimEnd().split("\n");

describe("the docker vocabulary", () => {
    it("builds with no network, quietly, from a plain directory and our own tag", async () => {
        const { docker, argv, env } = await recording();
        process.env.SECRET_FOR_TEST = "leak-me";
        try {
            await docker.build("/tmp/some-dir", TAG);
        } finally {
            delete process.env.SECRET_FOR_TEST;
        }
        expect(await lines(argv)).toEqual([
            "build",
            "--network",
            "none",
            "--quiet",
            "-t",
            TAG,
            "/tmp/some-dir",
        ]);
        expect(await fs.readFile(env, "utf8")).not.toContain("SECRET_FOR_TEST");
    });

    it("refuses a tag or directory it would not make, before running anything", async () => {
        const { docker, argv } = await recording();
        for (const tag of ["", "nginx:latest", `${TAG};ls`, "launchpad/site:ABC", `${TAG}\n`]) {
            await expect(docker.build("/tmp/d", tag)).rejects.toBeInstanceOf(
                DeploymentEffectNotStarted,
            );
            expect(() => docker.save(tag)).toThrow(/Refused/);
        }
        for (const dir of ["relative", "/tmp/a b", "/tmp/$(id)", "-f/x", "/tmp/a;b"]) {
            await expect(docker.build(dir, TAG)).rejects.toBeInstanceOf(DeploymentEffectNotStarted);
        }
        await expect(fs.stat(argv)).rejects.toThrow();
    });

    it("reports a failed build with bounded output as detail, not in the message", async () => {
        const { docker } = await recording(`echo "secret layer detail" >&2; exit 1`);
        const error = await docker.build("/tmp/d", TAG).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DockerError);
        expect((error as DockerError).message).toBe("The image build failed.");
        expect((error as DockerError).detail).toContain("secret layer detail");
    });

    it("streams a save, and surfaces a failure that happens part-way through", async () => {
        const ok = await recording(`printf 'ARCHIVE'`);
        const saved = ok.docker.save(TAG);
        let text = "";
        for await (const chunk of saved.stream) text += Buffer.from(chunk).toString();
        await saved.done;
        expect(text).toBe("ARCHIVE");
        expect(await lines(ok.argv)).toEqual(["save", TAG]);

        const broken = await recording(`printf 'PART'; echo boom >&2; exit 3`);
        const partial = broken.docker.save(TAG);
        for await (const _ of partial.stream) {
            // drained
        }
        await expect(partial.done).rejects.toBeInstanceOf(DockerError);
    });

    it("reads only a full image ID using the fixed inspection command", async () => {
        const id = `sha256:${"a".repeat(64)}`;
        const good = await recording(`echo '${id}'`);
        await expect(good.docker.imageId(TAG)).resolves.toBe(id);
        expect(await lines(good.argv)).toEqual(["image", "inspect", "--format", "{{.Id}}", TAG]);
        const bad = await recording("echo sha256:1234");
        await expect(bad.docker.imageId(TAG)).rejects.toBeInstanceOf(DockerError);
        await expect(bad.docker.imageId("nginx:latest")).rejects.toThrow(/Refused/);
    });

    it("keeps a bounded, whole-character diagnostic however the output is chunked", async () => {
        // 5000 two-byte characters on stderr: the limit is 4000 bytes, not characters.
        const { docker } = await recording(
            `i=0; while [ $i -lt 5000 ]; do printf '\\303\\251' >&2; i=$((i+1)); done; exit 1`,
        );
        const error = (await docker.build("/tmp/d", TAG).catch((e: unknown) => e)) as DockerError;
        expect(Buffer.byteLength(error.detail)).toBeLessThanOrEqual(4000);
        expect(error.detail).not.toContain("\uFFFD");
        expect(error.detail.length).toBeGreaterThan(1000);
    });

    it("bounds image removal with its own deadline", async () => {
        const bin = await fakeDocker(tmp.dir, "exec sleep 30");
        const docker = createDocker({ binary: bin, removeTimeoutMs: 300 });
        const started = Date.now();
        await docker.remove(TAG);
        expect(Date.now() - started).toBeLessThan(5000);
    });

    it("removes exactly one image, forced, and ignores a failure", async () => {
        const { docker, argv } = await recording("exit 1");
        await expect(docker.remove(TAG)).resolves.toBeUndefined();
        expect(await lines(argv)).toEqual(["rmi", "--force", TAG]);
        await expect(docker.remove("nginx:latest")).resolves.toBeUndefined();
    });

    it("removes one image by exact tag and says so if it could not, and accepts one already gone", async () => {
        const ok = await recording();
        await ok.docker.removeImage(TAG);
        expect(await lines(ok.argv)).toEqual(["rmi", "--force", TAG]);

        const gone = await recording(`echo "Error: No such image: ${TAG}" >&2; exit 1`);
        await expect(gone.docker.removeImage(TAG)).resolves.toBeUndefined();

        const busy = await recording(`echo "conflict: image is being used" >&2; exit 1`);
        const error = await busy.docker.removeImage(TAG).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DockerError);
        expect((error as DockerError).message).toBe("Removing the image failed.");
    });

    it("refuses to remove any image that is not one of ours, before running anything", async () => {
        const { docker, argv } = await recording();
        for (const tag of [
            "",
            "nginx:latest",
            "launchpad/site:latest",
            `${TAG};ls`,
            "-a",
            `${TAG}\n`,
            "launchpad/site",
        ]) {
            await expect(docker.removeImage(tag), tag).rejects.toThrow(/Refused/);
        }
        await expect(fs.stat(argv)).rejects.toThrow();
    });

    it("bounds a strict image removal with its own deadline", async () => {
        const bin = await fakeDocker(tmp.dir, "exec sleep 30");
        const docker = createDocker({ binary: bin, removeTimeoutMs: 300 });
        const started = Date.now();
        await expect(docker.removeImage(TAG)).rejects.toBeInstanceOf(DockerError);
        expect(Date.now() - started).toBeLessThan(5000);
    });

    it("kills a build that outlives its signal", async () => {
        const { docker } = await recording("exec sleep 30");
        const controller = new AbortController();
        const pending = docker.build("/tmp/d", TAG, controller.signal);
        setTimeout(() => controller.abort(), 200);
        const started = Date.now();
        await expect(pending).rejects.toBeInstanceOf(DockerError);
        expect(Date.now() - started).toBeLessThan(5000);
    });

    it("reports a missing binary as a failure, not a crash", async () => {
        const docker = createDocker({ binary: "/nonexistent/docker" });
        await expect(docker.build("/tmp/d", TAG)).rejects.toBeInstanceOf(DockerError);
    });
});
