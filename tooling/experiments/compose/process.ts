import { spawn } from "node:child_process";

export class FixtureProcessTimeout extends Error {}

export async function runFixtureProcess(
    args: string[],
    options: {
        env: Record<string, string>;
        input?: string;
        timeoutMs: number;
        signal?: AbortSignal;
    },
) {
    options.signal?.throwIfAborted();
    const p = spawn(args[0]!, args.slice(1), {
        detached: true, // POSIX group, including Docker CLI plugins and their local children.
        env: options.env,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const group = p.pid;
    let out = "";
    let err = "";
    p.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        out += chunk;
    });
    p.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        err += chunk;
    });
    p.stdin?.on("error", () => {}); // A CLI may exit before consuming its input.
    p.stdin?.end(options.input);
    const completed = new Promise<{ out: string; err: string; code: number }>((resolve, reject) => {
        p.once("error", reject);
        p.once("close", (code) => resolve({ out: out.trim(), err: err.trim(), code: code ?? 1 }));
    });
    const { promise, reject } = Promise.withResolvers<never>();
    const cancel = (error: unknown) => {
        // Signal the group even if its leader exited but a child still holds the pipes.
        if (group !== undefined) {
            try {
                process.kill(-group, "SIGKILL");
            } catch {
                // The group may have already exited. In either case the deadline settles locally.
            }
        }
        p.stdin?.destroy();
        p.stdout?.destroy();
        p.stderr?.destroy();
        reject(error);
    };
    const timer = setTimeout(
        () => cancel(new FixtureProcessTimeout("Fixture command timed out.")),
        Math.max(1, options.timeoutMs),
    );
    const abort = () => cancel(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
        return await Promise.race([completed, promise]);
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
    }
}
