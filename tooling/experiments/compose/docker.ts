import { COMPOSE_FILE } from "../../compose-production";
import { fixtureProblems, type planFixture } from "./fixture";

export type Fixture = ReturnType<typeof planFixture>;

export function fixtureDocker(plan: Fixture, files?: { env: string; override: string }) {
    const host = ["docker", "--host", "unix:///var/run/docker.sock"];
    const env = { PATH: Bun.env.PATH ?? "", HOME: Bun.env.HOME ?? "" };
    let uncertain = false;
    async function run(args: string[], input?: string, compose = false, allowFailure = false) {
        const p = Bun.spawn([...host, ...args], {
            env: compose ? { ...env, ...plan.env } : env,
            stdin: input === undefined ? "ignore" : new Blob([input]),
            stdout: "pipe",
            stderr: "pipe",
        });
        const timer = setTimeout(() => {
            uncertain = true;
            p.kill("SIGKILL");
        }, 900_000);
        const [out, err, code] = await Promise.all([
            new Response(p.stdout).text(),
            new Response(p.stderr).text(),
            p.exited.finally(() => clearTimeout(timer)),
        ]);
        if (uncertain) throw new Error("Docker client timed out; fixture state is uncertain.");
        // Neither argv nor child output is safe to log (even config contains passwords).
        if (code !== 0 && !allowFailure) throw new Error(`Docker ${args[0]} exited ${code}.`);
        return { out: out.trim(), err: err.trim(), code };
    }
    // Explicit files, or stdin for render-only mode. Never auto-discover configuration.
    const compose = (args: string[], input?: string) =>
        run(
            [
                "compose",
                "-p",
                plan.project,
                "--env-file",
                files?.env ?? "/dev/null",
                "-f",
                COMPOSE_FILE,
                "-f",
                files?.override ?? "-",
                ...args,
            ],
            files ? input : JSON.stringify(plan.override),
            true,
        );
    return {
        run: (args: string[], allowFailure = false, input?: string) =>
            run(args, input, false, allowFailure),
        compose,
        // Conservative: after any timed-out Docker client, its engine-side effects
        // are not known to have settled. Never use cleanup to guess.
        uncertain: () => uncertain,
        async validate() {
            const { out } = await compose(["--profile", "admin", "config", "--format", "json"]);
            let model: unknown;
            try {
                model = JSON.parse(out);
            } catch {
                throw new Error("Compose did not return a valid fixture model.");
            }
            const problems = fixtureProblems(model, plan);
            if (problems.length) throw new Error(problems.join("\n"));
        },
    };
}
