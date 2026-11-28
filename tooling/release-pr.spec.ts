import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { channelNames } from "./release-pr";

const root = path.resolve(import.meta.dirname, "..");
const file = readFileSync(path.join(root, ".github/workflows/release-pr.yaml"), "utf8");
// Comments may name what is forbidden.
const code = file.replace(/^\s*#.*$/gm, "");

interface Step {
    name?: string;
    id?: string;
    uses?: string;
    run?: string;
    if?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
    "continue-on-error"?: unknown;
}
interface Job {
    permissions?: Record<string, string>;
    env?: Record<string, string>;
    steps: Step[];
    if?: string;
}
const wf = Bun.YAML.parse(file) as {
    on: Record<string, { inputs?: Record<string, Record<string, unknown>> } | null>;
    permissions: Record<string, string>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    defaults: { run: { shell: string } };
    env: Record<string, string>;
    jobs: Record<string, Job>;
};
const job = wf.jobs.open!;
const steps = job.steps;
const named = (text: string) => steps.find((s) => (s.name ?? "").includes(text))!;
const index = (text: string) => steps.findIndex((s) => (s.name ?? "").includes(text));
const runs = steps.map((s) => s.run ?? "").join("\n");
const commands = runs
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

describe("release PR workflow trigger and inputs", () => {
    it("starts only by hand", () => {
        expect(Object.keys(wf.on)).toEqual(["workflow_dispatch"]);
        expect(code).not.toMatch(
            /repository_dispatch|schedule:|pull_request|workflow_call|^\s+push:/m,
        );
    });

    it("takes a base version and a channel chosen from a static list equal to the registry", () => {
        const inputs = wf.on.workflow_dispatch!.inputs!;
        expect(Object.keys(inputs)).toEqual(["base", "channel"]);
        expect(inputs.base).toMatchObject({ type: "string", required: true });
        expect(inputs.channel).toMatchObject({ type: "choice", required: true, default: "stable" });
        expect((inputs.channel!.options as string[]).toSorted()).toEqual(channelNames().toSorted());
    });

    it("runs one dispatch per base version at a time and never cancels one", () => {
        expect(wf.concurrency).toEqual({
            group: "release-pr-${{ inputs.base }}",
            "cancel-in-progress": false,
        });
    });
});

describe("release PR workflow runs from main only", () => {
    it("fails first, before anything is checked out, unless the ref is main", () => {
        expect(index("Run from main only")).toBe(0);
        const guard = steps[0]!;
        expect(guard.run).toContain('[ "$REF" != "refs/heads/main" ]');
        expect(guard.run).toContain("exit 1");
        expect(job.env?.REF).toBe("${{ github.ref }}");
        expect(steps.findIndex((s) => s.uses?.startsWith("actions/checkout@"))).toBe(1);
    });
});

describe("release PR workflow permissions and credentials", () => {
    it("holds nothing at workflow level and exactly three write scopes in the job", () => {
        expect(wf.permissions).toEqual({});
        expect(job.permissions).toEqual({
            contents: "write",
            "pull-requests": "write",
            actions: "write",
        });
        expect(Object.keys(wf.jobs)).toEqual(["open"]);
    });

    it("uses no secret and no token for a registry", () => {
        expect(code).not.toMatch(
            /secrets\.|id-token|packages:|NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/,
        );
        for (const m of code.match(/\$\{\{[^}]*\btoken\b[^}]*\}\}/g) ?? []) {
            expect(m).toMatch(/github\.token/);
        }
    });

    it("never keeps the token in the checkout, and gives it to the steps that need it only", () => {
        const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@"))!;
        expect(checkout.with).toMatchObject({
            "persist-credentials": false,
            "fetch-depth": 0,
            ref: "${{ github.sha }}",
        });
        expect(job.env?.GH_TOKEN).toBeUndefined();
        expect(wf.env.GH_TOKEN).toBeUndefined();
        const holders = steps.filter((s) => s.env?.GH_TOKEN !== undefined).map((s) => s.name);
        expect(holders).toEqual([
            "The release branch does not exist yet",
            "Push the release branch only",
            "Open the pull request",
            "Start CI on the branch",
        ]);
        // None of the steps that run dependencies or hooks has it.
        for (const name of [
            "Install dependencies",
            "Plan the release",
            "Cut the release branch",
            "Write the PR body",
        ]) {
            expect(named(name).env?.GH_TOKEN, name).toBeUndefined();
        }
    });

    it("passes untrusted inputs through env only", () => {
        for (const step of steps) expect(step.run ?? "", step.name).not.toContain("${{");
        expect(job.env).toMatchObject({
            BASE: "${{ inputs.base }}",
            CHANNEL: "${{ inputs.channel }}",
        });
        expect(named("Plan the release").run).toContain('--base "$BASE" --channel "$CHANNEL"');
    });
});

describe("release PR workflow never tags or publishes", () => {
    it("pushes only the release branch, with an explicit refspec", () => {
        const pushes = commands.filter((c) => /\bgit\b.*\bpush\b/.test(c));
        expect(pushes).toHaveLength(1);
        expect(pushes[0]).toMatch(/ push origin "HEAD:refs\/heads\/release\/\$VERSION"$/);
        expect(code).not.toMatch(/--tags|--force|--mirror|\+HEAD|--all|push --delete/);
        expect(code).not.toMatch(/refs\/tags/);
    });

    it("uses git tag only to delete the local tag cog made, and only once", () => {
        const tags = commands.filter((c) => /\bgit tag\b/.test(c));
        expect(tags).toEqual(['git tag -d "v$VERSION"']);
        expect(index("Delete the local tag")).toBeLessThan(index("Push the release branch only"));
        // The changelog range ends at that tag, so it is written first.
        expect(index("Write the PR body")).toBeLessThan(index("Delete the local tag"));
    });

    it("runs no publish, login, registry, docker or release command", () => {
        expect(code).not.toMatch(
            /\b(npm|bun|yarn|pnpm) (publish|login|dist-tag|deprecate|adduser)\b|docker |gh release|gh api -X (POST|PUT|PATCH|DELETE)|imagetools|gh pr merge|--admin/,
        );
        const gh = commands.filter((c) => /^(gh|.*\| jq)/.test(c) || c.startsWith("gh "));
        for (const command of commands.filter((c) => c.startsWith("gh "))) {
            expect(command).toMatch(
                /^gh (api "repos\/\$GITHUB_REPOSITORY\/git\/matching-refs\/heads\/release\/\$VERSION"|pr create --base main --head "release\/\$VERSION"|workflow run ci\.yaml --ref "release\/\$VERSION")/,
            );
        }
        expect(gh.length).toBeGreaterThan(0);
    });

    it("bumps with the one supported command, then opens a Conventional Commit titled PR", () => {
        expect(commands).toContain('cog bump --version "$VERSION" --include-packages');
        expect(runs).toContain('--title "chore(release): v$VERSION"');
        expect(runs).toContain('cog verify "chore(release): v$VERSION"');
        expect(index("Open the pull request")).toBeLessThan(index("Start CI on the branch"));
        expect(named("Start CI").run).toBe('gh workflow run ci.yaml --ref "release/$VERSION"');
    });

    it("refuses an existing release branch before it creates one", () => {
        expect(index("The release branch does not exist yet")).toBeLessThan(
            index("Cut the release branch"),
        );
        expect(named("The release branch does not exist yet").run).toContain('"$count" != 0');
    });
});

describe("release PR workflow supply chain", () => {
    it("pins every action by full commit SHA with the version in a comment", () => {
        const uses = file.split("\n").filter((line) => /^\s*(- )?uses:/.test(line));
        expect(uses.length).toBeGreaterThan(2);
        for (const line of uses) {
            expect(line, line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/);
        }
    });

    it("restores no cache", () => {
        expect(code).not.toMatch(
            /actions\/cache|setup-omni|setup-workspace|cache-from|cache-to|restore-keys/,
        );
        for (const step of steps) {
            if (step.uses?.startsWith("actions/setup-node")) {
                expect(step.with?.["package-manager-cache"]).toBe(false);
            }
            if (step.uses?.startsWith("oven-sh/setup-bun"))
                expect(step.with?.["no-cache"]).toBe(true);
        }
    });

    it("installs Omni and Cocogitto from pinned releases whose checksums are verified", () => {
        expect(wf.env.OMNI_SHA256).toMatch(/^[0-9a-f]{64}$/);
        expect(wf.env.COG_SHA256).toMatch(/^[0-9a-f]{64}$/);
        expect(wf.env.COG_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
        expect(named("Install Omni").run).toContain("sha256sum -c -");
        expect(named("Install Cocogitto").run).toContain("sha256sum -c -");
        const release = (
            Bun.YAML.parse(
                readFileSync(path.join(root, ".github/workflows/release.yaml"), "utf8"),
            ) as { env: Record<string, string> }
        ).env;
        expect(wf.env.OMNI_VERSION).toBe(release.OMNI_VERSION);
        expect(wf.env.OMNI_SHA256).toBe(release.OMNI_SHA256);
        expect(index("Install dependencies")).toBeGreaterThan(index("Install Cocogitto"));
        expect(named("Install dependencies").run).toBe("bun install --frozen-lockfile");
    });

    it("runs in bash, with no conditional steps and no failures swallowed", () => {
        expect(wf.defaults.run.shell).toBe("bash");
        expect(job.if).toBeUndefined();
        for (const step of steps) {
            expect(step.if, step.name).toBeUndefined();
            expect(step["continue-on-error"], step.name).toBeUndefined();
        }
        expect(code).not.toMatch(/\|\| true|set \+e|continue-on-error/);
    });
});
