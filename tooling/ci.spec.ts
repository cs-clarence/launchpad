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

    // The release-PR workflow dispatches CI on a release branch; the required `CI Passed` check must
    // report there under the same name, with the PR-only commits job skipped.
    it("can be dispatched, with the commits job run and the gate under the same name", () => {
        const on = (
            Bun.YAML.parse(readFileSync(path.join(workflows, "ci.yaml"), "utf8")) as { on: object }
        ).on;
        expect(Object.keys(on)).toContain("workflow_dispatch");
        expect(ci.jobs.commits!.if).toBe(
            "${{ github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch' }}",
        );
        // The dispatched check is of what the branch adds to origin/main.
        const commitsStep = ci.jobs.commits!.steps!.find((s) => s.uses?.startsWith("cocogitto/"))!;
        expect(commitsStep.with?.args).toContain("'origin/main..HEAD'");
        expect(commitsStep.with?.args).toContain("github.event.pull_request.base.sha");
        expect(gate.name).toBe("CI Passed");
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
            runs('echo "omni -i run release:dry-run -p @launchpad-kit/tooling"', "release:dry-run"),
        ).toBe(false);
        expect(
            runs("  omni -i run release:dry-run -p '@launchpad-kit/tooling'", "release:dry-run"),
        ).toBe(true);
    });

    it("runs the packages job on the Node floor and the current Node", () => {
        const job = ci.jobs.packages as Job & { strategy?: { matrix: { node: string[] } } };
        expect(job.strategy?.matrix.node).toEqual(["22.12", "current"]);
        const setup = job.steps!.find((s) => s.uses?.endsWith("setup-workspace"));
        expect(setup?.with?.["node-version"]).toBe("${{ matrix.node }}");
        const action = Bun.YAML.parse(
            readFileSync(path.join(root, ".github/actions/setup-workspace/action.yaml"), "utf8"),
        ) as { runs: { steps: Step[] } };
        const node = action.runs.steps.find((s) => s.uses?.startsWith("actions/setup-node@"));
        expect(node?.with?.["node-version"]).toBe("${{ inputs.node-version }}");
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

    // The commit check runs on a pull request and on a dispatch (the release branch); it is skipped
    // on a push to main and in the merge queue.
    const checked = ["pull_request", "workflow_dispatch"];
    const unchecked = ["push", "merge_group"];

    it("passes a pull request or a dispatch where every job succeeded", () => {
        for (const event of checked) expect(evaluate(event, allGreen), event).toBeUndefined();
    });

    it("passes a push or merge-queue run where only commits was skipped", () => {
        for (const event of unchecked) {
            expect(evaluate(event, { ...allGreen, commits: "skipped" }), event).toBeUndefined();
        }
    });

    it("fails when any job failed or was cancelled, on every event", () => {
        for (const event of [...checked, ...unchecked]) {
            const jobs = ["check", "build", "test", "integration", "packages"];
            for (const job of checked.includes(event) ? ["commits", ...jobs] : jobs) {
                for (const result of ["failure", "cancelled"]) {
                    expect(
                        evaluate(event, { ...allGreen, [job]: result }),
                        `${event} ${job} ${result}`,
                    ).toContain(job);
                }
            }
        }
    });

    it("fails when a required job was skipped, as happens when an earlier job failed", () => {
        for (const event of [...checked, ...unchecked]) {
            for (const job of ["check", "build", "test", "integration", "packages"]) {
                const commits = checked.includes(event) ? "success" : "skipped";
                expect(
                    evaluate(event, { ...allGreen, commits, [job]: "skipped" }),
                    `${event} ${job}`,
                ).toContain(job);
            }
        }
    });

    it("fails a pull request or a dispatch whose commit check was skipped", () => {
        for (const event of checked) {
            expect(evaluate(event, { ...allGreen, commits: "skipped" }), event).toContain(
                "commits",
            );
        }
    });

    it("fails a push or merge-queue run where the commit check unexpectedly ran", () => {
        for (const event of unchecked) {
            for (const result of ["failure", "success"]) {
                expect(
                    evaluate(event, { ...allGreen, commits: result }),
                    `${event} ${result}`,
                ).toContain("commits");
            }
        }
    });
});

// Only .github/workflows/release.yaml may publish (docs/decisions/release-publishing.md), and
// tooling/release.spec.ts asserts that file. Every other workflow, and the composite action they
// use, must not publish, push, tag, log in to a registry or hold a credential.
const RELEASE_WORKFLOW = "release.yaml";
// The one other workflow that may write: it pushes a `release/<version>` branch and opens a PR, and
// never tags or publishes (tooling/release-pr.spec.ts asserts it). Its carve-out below is exact:
// these two command lines and these three job permissions, nothing else.
const RELEASE_PR_WORKFLOW = "release-pr.yaml";
const RELEASE_PR_ALLOWED_COMMANDS = [
    'git tag -d "v$VERSION"',
    'git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" push origin "HEAD:refs/heads/release/$VERSION"',
];
const RELEASE_PR_WRITES = ["open: contents", "open: pull-requests", "open: actions"];
const actionFile = path.join(root, ".github", "actions", "setup-workspace", "action.yaml");
const others = [
    ...readdirSync(workflows)
        .filter((name) => name !== RELEASE_WORKFLOW)
        .map((name) => path.join(workflows, name)),
    actionFile,
];

interface Doc {
    on?: unknown;
    permissions?: unknown;
    jobs?: Record<string, Job & { permissions?: unknown; uses?: unknown }>;
    runs?: { steps: Step[] };
}
const parse = (text: string) => Bun.YAML.parse(text) as Doc;
const stepsOf = (doc: Doc) => [
    ...Object.values(doc.jobs ?? {}).flatMap((job) => job.steps ?? []),
    ...(doc.runs?.steps ?? []),
];

// Commands the shell would run: comments are not commands.
const commandsOf = (text: string) =>
    stepsOf(parse(text))
        .map((step) => step.run ?? "")
        .join("\n")
        .replace(/^\s*#.*$/gm, "");

const FORBIDDEN_COMMAND =
    /\b(publish|push|login|logout|tag|release create|imagetools create|attestation|provenance|send-pack|update-ref|fast-import)\b|docker (push|login|tag)/;
const FORBIDDEN_ACTION =
    /^(docker\/(login-action|build-push-action)|actions\/(attest|attest-build-provenance)|softprops\/|ncipollo\/|changesets\/|JS-DevTools\/npm-publish)/;

// The parsed value, so `packages: "write"`, `'write'` and any other spelling count alike.
const writes = (permissions: unknown): string[] => {
    if (permissions === undefined || permissions === null) return [];
    if (typeof permissions === "string") return /write/i.test(permissions) ? [permissions] : [];
    return Object.entries(permissions as Record<string, unknown>)
        .filter(
            ([scope, level]) =>
                scope.trim().toLowerCase() === "id-token" ||
                String(level).trim().toLowerCase() === "write",
        )
        .map(([scope]) => scope);
};
const permissionProblems = (doc: Doc) => [
    ...writes(doc.permissions),
    ...Object.entries(doc.jobs ?? {}).flatMap(([id, job]) =>
        writes(job.permissions).map((scope) => `${id}: ${scope}`),
    ),
];

// Actions as parsed (the YAML value, never the raw token), also a reusable workflow call.
const actionsOf = (doc: Doc) => [
    ...Object.values(doc.jobs ?? {}).flatMap((job) =>
        typeof job.uses === "string" ? [job.uses] : [],
    ),
    ...stepsOf(doc).flatMap((step) => (step.uses ? [step.uses] : [])),
];

// What can start the workflow on a tag: a push with no `branches` filter fires on tag pushes too
// (GitHub starts it for every ref type when no filter is given), and so do `create` and `release`.
const triggerProblems = (on: unknown): string[] => {
    const events: Record<string, any> =
        typeof on === "string"
            ? { [on]: null }
            : Array.isArray(on)
              ? Object.fromEntries(on.map((event) => [String(event), null]))
              : ((on ?? {}) as Record<string, any>);
    const problems: string[] = [];
    for (const [event, filter] of Object.entries(events)) {
        if (event === "create" || event === "release") problems.push(`${event} can start on a tag`);
        if (filter?.tags !== undefined || filter?.["tags-ignore"] !== undefined) {
            problems.push(`${event} filters tags`);
        }
        if (
            event === "push" &&
            (!Array.isArray(filter?.branches) || filter.branches.length === 0)
        ) {
            problems.push("push has no branch filter, so it also fires on tag pushes");
        }
    }
    return problems;
};

// What is left of a workflow's commands once the release-PR carve-out's exact lines are removed.
const afterCarveOut = (commands: string) =>
    commands
        .split("\n")
        .filter((line) => !RELEASE_PR_ALLOWED_COMMANDS.includes(line.trim()))
        .join("\n");
const strict = others.filter((file) => path.basename(file) !== RELEASE_PR_WORKFLOW);

describe("every workflow except the release workflow", () => {
    it("is checked, and the release workflow is the only one exempt", () => {
        expect(readdirSync(workflows).toSorted()).toEqual([
            "ci.yaml",
            "release-dry-run.yaml",
            RELEASE_PR_WORKFLOW,
            RELEASE_WORKFLOW,
        ]);
        expect(others).toHaveLength(4);
        expect(strict).toHaveLength(3);
    });

    it("keeps one narrow carve-out for the release-PR workflow", () => {
        const text = readFileSync(path.join(workflows, RELEASE_PR_WORKFLOW), "utf8");
        const doc = parse(text);
        expect(permissionProblems(doc)).toEqual(RELEASE_PR_WRITES);
        expect(doc.permissions).toEqual({});
        // Its commands are clean once the two exact lines are set aside.
        expect(afterCarveOut(commandsOf(text))).not.toMatch(FORBIDDEN_COMMAND);
        expect(commandsOf(text)).toContain("git tag -d");
        for (const used of actionsOf(doc)) expect(used).not.toMatch(FORBIDDEN_ACTION);
    });

    it("refuses anything beyond the carve-out", () => {
        for (const command of [
            "git push origin v1.0.0",
            "git push --tags",
            'git push origin "HEAD:refs/tags/v$VERSION"',
            'git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" push origin "HEAD:refs/heads/release/$VERSION" --force',
            'git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" push origin main',
            "git tag v1.0.0",
            'git tag -d "v$VERSION" && git push origin v1',
            "npm publish",
            "gh release create v1",
        ]) {
            expect(afterCarveOut(command), command).toMatch(FORBIDDEN_COMMAND);
        }
        for (const command of RELEASE_PR_ALLOWED_COMMANDS) {
            expect(afterCarveOut(`  ${command}`)).not.toMatch(FORBIDDEN_COMMAND);
        }
    });

    it("uses no secret and no publishing credential", () => {
        for (const file of others) {
            const text = readFileSync(file, "utf8").replace(/^\s*#.*$/gm, "");
            expect(text, file).not.toMatch(/secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/);
        }
    });

    it("holds no write permission and no id-token at workflow or job scope", () => {
        for (const file of strict) {
            expect(permissionProblems(parse(readFileSync(file, "utf8"))), file).toEqual([]);
        }
    });

    it("rejects write permissions however they are written", () => {
        for (const text of [
            'permissions:\n  packages: "write"\njobs: {}',
            "permissions:\n  attestations: 'write'\njobs: {}",
            "permissions: write-all\njobs: {}",
            "permissions:\n  id-token: read\njobs: {}",
            'jobs:\n  a:\n    permissions:\n      "artifact-metadata": "write"\n    steps: []',
            "jobs:\n  a:\n    permissions: { contents: write }\n    steps: []",
        ]) {
            expect(permissionProblems(parse(text)), text).not.toEqual([]);
        }
        expect(permissionProblems(parse("permissions:\n  contents: read\njobs: {}"))).toEqual([]);
    });

    it("runs no publishing, pushing, tagging or login command and uses no publishing action", () => {
        for (const file of strict) {
            const text = readFileSync(file, "utf8");
            expect(commandsOf(text), file).not.toMatch(FORBIDDEN_COMMAND);
            for (const used of actionsOf(parse(text)))
                expect(used, file).not.toMatch(FORBIDDEN_ACTION);
        }
    });

    it("reads quoted and unquoted action references alike", () => {
        for (const text of [
            "jobs:\n  a:\n    steps:\n      - uses: docker/login-action@v4",
            'jobs:\n  a:\n    steps:\n      - uses: "docker/login-action@v4"',
            "jobs:\n  a:\n    steps:\n      - uses: 'actions/attest@v4'",
            "jobs:\n  a:\n    uses: docker/build-push-action@v7",
            'runs:\n  using: composite\n  steps:\n    - uses: "docker/login-action@v4"',
        ]) {
            const used = actionsOf(parse(text));
            expect(used, text).toHaveLength(1);
            expect(used[0], text).toMatch(FORBIDDEN_ACTION);
        }
        expect(
            actionsOf(parse("jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v6"))[0],
        ).not.toMatch(FORBIDDEN_ACTION);
    });

    it("lets none of them start on a tag push", () => {
        for (const file of others.filter((f) => f.startsWith(workflows))) {
            expect(triggerProblems(parse(readFileSync(file, "utf8")).on), file).toEqual([]);
        }
    });

    it("rejects triggers that can fire on a tag", () => {
        for (const on of [
            { push: {} },
            { push: null },
            "push",
            ["push", "workflow_dispatch"],
            { push: { tags: ["v*"] } },
            { push: { branches: ["main"], "tags-ignore": ["x"] } },
            { push: { branches: [] } },
            { create: null },
            { release: { types: ["published"] } },
            { pull_request: { tags: ["v*"] } },
        ]) {
            expect(triggerProblems(on), JSON.stringify(on)).not.toEqual([]);
        }
        expect(triggerProblems({ push: { branches: ["main"] }, merge_group: null })).toEqual([]);
        expect(triggerProblems({ workflow_dispatch: null })).toEqual([]);
    });

    it("keeps the release rehearsal manual, read-only and environment-free", () => {
        const parsed = Bun.YAML.parse(
            readFileSync(path.join(workflows, "release-dry-run.yaml"), "utf8"),
        ) as {
            on: Record<string, unknown>;
            permissions: Record<string, string>;
            jobs: Record<string, Job & { permissions?: unknown; environment?: unknown }>;
        };
        expect(Object.keys(parsed.on)).toEqual(["workflow_dispatch"]);
        expect(parsed.permissions).toEqual({ contents: "read" });
        for (const job of Object.values(parsed.jobs)) {
            expect(job.permissions).toBeUndefined();
            expect(job.environment).toBeUndefined();
        }
        expect(
            runs(
                commandsOf(readFileSync(path.join(workflows, "release-dry-run.yaml"), "utf8")),
                "release:dry-run",
            ),
        ).toBe(true);
    });

    it("recognises the commands it forbids", () => {
        for (const command of [
            "npm publish ./a.tgz",
            "bun publish",
            "docker login ghcr.io",
            "docker push x",
            "git tag v1",
            "git push origin v1",
            "gh release create v1",
            "docker buildx imagetools create -t a b",
            "git send-pack origin x",
            "git update-ref refs/heads/main HEAD",
            "git fast-import < x",
        ]) {
            expect(command, command).toMatch(FORBIDDEN_COMMAND);
        }
        expect("omni -i run release:dry-run -p tooling").not.toMatch(FORBIDDEN_COMMAND);
        expect("uses: docker/login-action@v4").toMatch(/docker\/login-action/);
    });
});
