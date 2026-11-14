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
        ]) {
            expect(all, task).toMatch(new RegExp(`omni -i run [^\\n]*\\b${task}\\b`));
        }
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
        for (const job of ["commits", "check", "build", "test", "integration"]) {
            for (const result of ["failure", "cancelled"]) {
                expect(
                    evaluate("pull_request", { ...allGreen, [job]: result }),
                    `${job} ${result}`,
                ).toContain(job);
            }
        }
    });

    it("fails when a required job was skipped, as happens when an earlier job failed", () => {
        for (const job of ["check", "build", "test", "integration"]) {
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
