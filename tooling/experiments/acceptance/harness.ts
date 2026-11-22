import { randomBytes } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

export type Result = { out: string; err: string; code: number };

export interface Resources {
    dir: string;
    network: string;
    containers: {
        dokku: string;
        postgres: string;
        router: string;
        proxy: string;
        controller: string;
        worker1: string;
        worker2: string;
    };
    images: { controller: string; worker: string; router: string };
    restore?: {
        adminImage: string;
        controller: string;
        database: string;
        directory: string;
    };
    volumes: string[];
    helpers: string[];
    // Fixture apps and image tags are chosen by the product, not by this harness. Each is recorded
    // here as soon as the controller reports it, and only names that match the product's own
    // fixed shape (and came from this run's own database) are ever passed to Docker or Dokku.
    discovered: { deploymentId: string; app: string; imageTag: string }[];
}

export const NAME = {
    app: /^lp-[a-z0-9]{10}$/,
    tag: /^launchpad\/site:[0-9a-f]{32}$/,
};

// Docker commands never inherit the repository's .env.local or any production setting.
export async function command(args: string[], allowFailure = false, stdin?: string) {
    const p = Bun.spawn(args, {
        env: { PATH: process.env.PATH!, HOME: process.env.HOME!, DOCKER_BUILDKIT: "1" },
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
        stdout: "pipe",
        stderr: "pipe",
    });
    const deadline = setTimeout(() => p.kill("SIGKILL"), 900_000);
    const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited.finally(() => clearTimeout(deadline)),
    ]);
    if (code && !allowFailure) throw new Error(`${args.slice(0, 3).join(" ")}: ${err}`);
    return { out: out.trim(), err: err.trim(), code } satisfies Result;
}

export const randomHex = (bytes: number) => randomBytes(bytes).toString("hex");

// Docker requires PID to filter host ps output to the fixture's processes.
export function dokkuIdle(result: Result): boolean {
    const [header, ...commands] = result.out.split("\n");
    return (
        result.code === 0 &&
        /^PID\s+COMMAND\s+COMMAND$/.test(header ?? "") &&
        commands.length > 0 &&
        !commands.some((line) =>
            /(?:^|[\s/])(?:dokku|docker|sshcommand)(?=\s|$)|sshd:\s+dokku\b/.test(line),
        )
    );
}

export function raceRounds(raw: string | undefined): number {
    const count = Number(raw ?? "3");
    if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error("LAUNCHPAD_ACCEPTANCE_RACE_ROUNDS must be a positive integer.");
    }
    return count;
}

// "Absent" only when Docker says so: a failed inspection (the engine unreachable, say) proves nothing.
const NOT_FOUND = /\bno such (container|image|network|volume|object)\b|\bnetwork \S+ not found\b/i;
export const confirmedAbsent = (result: { code: number; err: string }) =>
    result.code !== 0 && NOT_FOUND.test(result.err);

export function createDocker(r: Resources) {
    const inventory = `${r.dir}/resources.json`;
    let pending = Promise.resolve();
    const persist = () => {
        const write = pending.then(async () => {
            // Keep the last good inventory if a write is interrupted or fails.
            await writeFile(`${inventory}.next`, JSON.stringify(r, null, 2));
            await rename(`${inventory}.next`, inventory);
        });
        pending = write.catch(() => undefined);
        return write;
    };
    const docker = async (args: string[], allowFailure = false, stdin?: string) => {
        if (args[0] === "run" && !args.includes("--name")) {
            const name = `${r.network.replace(/-net$/, "")}-helper-${r.helpers.length + 1}`;
            r.helpers.push(name);
            await persist();
            args = [...args];
            args.splice(1, 0, "--name", name);
        }
        // Match the host socket mounted in the worker and Dokku, regardless of the CLI context.
        return command(
            ["docker", "--host", "unix:///var/run/docker.sock", ...args],
            allowFailure,
            stdin,
        );
    };
    return { docker, persist };
}

// What the run proved, one entry per scenario. Mechanisms other than the public HTTP API (a SQL
// read, a docker pause, a proxy fault) are named in `mechanism`; nothing here is a claim the
// harness did not exercise.
export interface Evidence {
    id: string;
    title: string;
    result: "pass" | "fail";
    mechanism: string;
    observations: Record<string, unknown>;
    error?: string;
}
