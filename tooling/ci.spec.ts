import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const workflows = path.join(root, ".github", "workflows");

interface Step {
    name?: string;
    uses?: string;
    run?: string;
    with?: Record<string, string>;
    env?: Record<string, string>;
}
interface Job {
    name?: string;
    needs?: string[];
    if?: string;
    steps?: Step[];
}
const load = (file: string) =>
    Bun.YAML.parse(readFileSync(path.join(workflows, file), "utf8")) as {
        jobs: Record<string, Job>;
    };

const ci = load("ci.yaml");
const gate = ci.jobs["ci-gatekeeper"]!;

// True when an `omni -i run` command at the start of a line names exactly this task as a
// positional argument: not an option's value, not text after a `#`, not a quoted `echo`.
const VALUE_OPTIONS = new Set(["-p", "--project", "-e", "--env-file", "-a", "--args"]);
const runs = (commands: string, task: string) =>
    commands.split("\n").some((line) => {
        // Only what Omni itself is given: stop at a comment or a command separator, and set
        // redirections (`>log`, `2>&1`) aside, since they do not change which task Omni gets.
        const command = line
            .split("#")[0]!
            .split(/&&|\|\||[;|]/)[0]!
            .replace(/\d*(?:>>?|<)(?:&\d+|\s*\S+)/g, " ");
        const match = command.match(/^\s*omni -i run\b(.*)$/);
        if (!match) return false;
        const tokens = match[1]!.trim().split(/\s+/).filter(Boolean);
        const positional: string[] = [];
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i]!;
            if (token.startsWith("-")) {
                if (VALUE_OPTIONS.has(token)) i++;
            } else {
                positional.push(token);
            }
        }
        return positional.includes(task);
    });

describe("CI workflow", () => {
    // Adding a job without adding it to the gate would let it fail unnoticed.
    it("makes the gatekeeper depend on every other job", () => {
        const others = Object.keys(ci.jobs).filter((id) => id !== "ci-gatekeeper");
        expect(gate.needs?.toSorted()).toEqual(others.toSorted());
    });

    it("always runs the gatekeeper, under a stable name", () => {
        expect(gate.if).toBe("${{ always() }}");
        expect(gate.name).toBe("CI Passed");
    });

    it("runs project work through Omni, not by calling package scripts", () => {
        for (const file of readdirSync(workflows)) {
            for (const [id, job] of Object.entries(load(file).jobs)) {
                for (const step of job.steps ?? []) {
                    expect(step.run ?? "", `${file}/${id}: ${step.name}`).not.toMatch(
                        /\bbun (run|x|test)\b|\bvitest\b|\btsc\b|\boxlint\b|\boxfmt\b/,
                    );
                }
            }
        }
    });

    it("runs every check, build and test task the repository defines", () => {
        const commands = Object.values(ci.jobs).flatMap((job) =>
            (job.steps ?? []).map((s) => s.run ?? ""),
        );
        const all = commands.join("\n");
        for (const task of [
            "check",
            "check:compose",
            "build",
            "test",
            "test:integration",
            "test:db:up",
            "test:packages",
            "test:images",
        ]) {
            expect(runs(all, task), task).toBe(true);
        }
        // `test` must not be satisfied by `test:integration`, nor `check` by `check:compose`.
        expect(runs("omni -i run test:integration", "test")).toBe(false);
        expect(runs("omni -i run check:compose", "check")).toBe(false);
        expect(runs("omni -i run -f=failed check check:compose", "check")).toBe(true);
        expect(
            runs('echo "omni -i run release:dry-run -p @launchpad/tooling"', "release:dry-run"),
        ).toBe(false);
        expect(
            runs("  omni -i run release:dry-run -p '@launchpad/tooling'", "release:dry-run"),
        ).toBe(true);
    });

    it("pins the Omni version used by the setup action", () => {
        const action = Bun.YAML.parse(
            readFileSync(path.join(root, ".github/actions/setup-workspace/action.yaml"), "utf8"),
        ) as { inputs: Record<string, { default?: string }> };
        expect(action.inputs["omni-version"]?.default).toMatch(/^\d+\.\d+\.\d+$/);
    });
});

// Run the real gatekeeper script against each combination of upstream results.
describe("CI gatekeeper script", () => {
    const script = gate.steps![0]!.with!.script as string;

    function evaluate(event: string, results: Record<string, string>) {
        const log: string[] = [];
        let failure: string | undefined;
        const core = {
            info: (m: string) => log.push(m),
            setFailed: (m: string) => (failure = m),
        };
        const env = { EVENT_NAME: event, RESULTS_JSON: JSON.stringify(results) };
        new Function("core", "process", script)(core, { env });
        return failure;
    }

    const allGreen = {
        commits: "success",
        check: "success",
        build: "success",
        test: "success",
        integration: "success",
        packages: "success",
    };

    it("passes a pull request where every job succeeded", () => {
        expect(evaluate("pull_request", allGreen)).toBeUndefined();
    });

    it("passes a push or merge-queue run where only commits was skipped", () => {
        for (const event of ["push", "merge_group"]) {
            expect(evaluate(event, { ...allGreen, commits: "skipped" })).toBeUndefined();
        }
    });

    it("fails when any job failed or was cancelled", () => {
        for (const job of ["commits", "check", "build", "test", "integration", "packages"]) {
            for (const result of ["failure", "cancelled"]) {
                expect(
                    evaluate("pull_request", { ...allGreen, [job]: result }),
                    `${job} ${result}`,
                ).toContain(job);
            }
        }
    });

    it("fails when a required job was skipped, as happens when an earlier job failed", () => {
        for (const job of ["check", "build", "test", "integration", "packages"]) {
            expect(
                evaluate("push", { ...allGreen, commits: "skipped", [job]: "skipped" }),
                job,
            ).toContain(job);
        }
    });

    it("fails a pull request whose commit check was skipped", () => {
        expect(evaluate("pull_request", { ...allGreen, commits: "skipped" })).toContain("commits");
    });

    it("fails a push where the commit check unexpectedly ran and failed", () => {
        expect(evaluate("push", { ...allGreen, commits: "failure" })).toContain("commits");
    });
});

// The release rehearsal must stay a rehearsal: manual, read-only, with no credential and no
// command that publishes, pushes, tags or logs in.
describe("release dry-run workflow", () => {
    const file = readFileSync(path.join(workflows, "release-dry-run.yaml"), "utf8");
    const parsed = Bun.YAML.parse(file) as {
        on: Record<string, unknown>;
        permissions: Record<string, string>;
        jobs: Record<string, Job & { permissions?: unknown; environment?: unknown }>;
    };

    it("starts only by hand, with read-only permissions", () => {
        expect(Object.keys(parsed.on)).toEqual(["workflow_dispatch"]);
        expect(parsed.permissions).toEqual({ contents: "read" });
        for (const job of Object.values(parsed.jobs)) {
            expect(job.permissions).toBeUndefined();
            expect(job.environment).toBeUndefined();
        }
    });

    it("uses no secret and no publishing, pushing, tagging or login command", () => {
        expect(file).not.toMatch(/secrets\.|id-token|NODE_AUTH_TOKEN|NPM_TOKEN/);
        const commands = Object.values(parsed.jobs)
            .flatMap((job) => job.steps ?? [])
            .map((step) => step.run ?? "")
            .join("\n")
            // A shell comment is not a command.
            .replace(/^\s*#.*$/gm, "");
        expect(commands).not.toMatch(
            /\b(publish|push|login|release create|git tag)\b|docker (push|login)/,
        );
        expect(runs(commands, "release:dry-run")).toBe(true);
    });
});
