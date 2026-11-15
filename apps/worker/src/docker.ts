import { spawn } from "node:child_process";

// The Docker engine is reached only through this fixed vocabulary: build the fixed
// template, save that image, remove that image. Every argument is validated by the
// caller, nothing runs through a shell, and the environment is minimal.

export interface RunResult {
    exitCode: number | null;
    stderr: string;
}

const TAG = /^launchpad\/site:[0-9a-f]{32}$/;
const PLAIN_PATH = /^\/[A-Za-z0-9._/@+-]{1,500}$/;
const KILL_GRACE_MS = 2000;

function minimalEnv(): Record<string, string> {
    // DOCKER_HOST is kept: it is how an operator points the worker at its engine.
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" };
    if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST;
    if (process.env.HOME) env.HOME = process.env.HOME;
    return env;
}

// Keeps at most `limit` bytes and decodes once at the end, so a multibyte character is
// never counted in the wrong unit or decoded from a half-chunk.
function bounded(limit: number) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    return {
        add(chunk: Buffer) {
            if (bytes >= limit) return;
            const part = chunk.subarray(0, limit - bytes);
            chunks.push(part);
            bytes += part.length;
        },
        get text() {
            return Buffer.concat(chunks).toString("utf8");
        },
    };
}

export class DockerError extends Error {
    constructor(
        message: string,
        readonly detail: string,
    ) {
        super(message);
        this.name = "DockerError";
    }
}

export function createDocker(options: { binary?: string; removeTimeoutMs?: number } = {}) {
    const binary = options.binary ?? "docker";
    const removeTimeoutMs = options.removeTimeoutMs ?? 20_000;

    function start(args: string[], signal: AbortSignal | undefined) {
        const child = spawn(binary, args, {
            stdio: ["ignore", "pipe", "pipe"],
            env: minimalEnv(),
            shell: false,
            windowsHide: true,
        });
        const stderr = bounded(4000);
        child.stderr.on("data", (chunk: Buffer) => stderr.add(chunk));
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const stop = () => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        };
        if (signal?.aborted) stop();
        else signal?.addEventListener("abort", stop, { once: true });
        const exited = new Promise<RunResult>((resolve) => {
            child.on("error", () =>
                resolve({ exitCode: 127, stderr: "docker could not be started" }),
            );
            child.on("close", (exitCode) => {
                clearTimeout(killTimer);
                signal?.removeEventListener("abort", stop);
                resolve({ exitCode, stderr: stderr.text });
            });
        });
        return { child, exited };
    }

    return {
        // `docker build` of a directory that holds the fixed Dockerfile, `nginx.conf` and
        // `site/`. No network is offered to the build, which has no RUN steps anyway.
        async build(contextDir: string, tag: string, signal?: AbortSignal): Promise<void> {
            if (!PLAIN_PATH.test(contextDir) || !TAG.test(tag)) {
                throw new Error("Refused: not a build directory or image tag this worker makes.");
            }
            const { child, exited } = start(
                ["build", "--network", "none", "--quiet", "-t", tag, contextDir],
                signal,
            );
            child.stdout.resume();
            const result = await exited;
            if (result.exitCode !== 0) {
                throw new DockerError("The image build failed.", result.stderr);
            }
        },

        // Streams `docker save` of one image. The stream ends when docker's output does;
        // `done` settles with docker's own exit status and must be awaited too, since a
        // failure part-way through leaves a truncated archive that looks like a stream.
        save(tag: string, signal?: AbortSignal) {
            if (!TAG.test(tag)) throw new Error("Refused: not an image tag this worker makes.");
            const { child, exited } = start(["save", tag], signal);
            const done = exited.then((result) => {
                if (result.exitCode !== 0) {
                    throw new DockerError("Saving the image failed.", result.stderr);
                }
            });
            // The rejection is observed by whoever awaits `done`.
            done.catch(() => {});
            return { stream: child.stdout as AsyncIterable<Uint8Array>, done };
        },

        // Best effort: removes exactly this image, never a prune.
        async remove(tag: string): Promise<void> {
            if (!TAG.test(tag)) return;
            // Its own deadline, independent of any deployment's signal: cleanup must stay
            // bounded even when that signal is already aborted (a shutdown).
            const { exited } = start(["rmi", "--force", tag], AbortSignal.timeout(removeTimeoutMs));
            await exited;
        },
    };
}

export type Docker = ReturnType<typeof createDocker>;
