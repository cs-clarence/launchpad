import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHANNELS, type Kind } from "./release-channels";
import { checkTag, IMAGES, TAG_PATTERN } from "./release-plan";

const root = path.resolve(import.meta.dirname, "..");
const file = readFileSync(path.join(root, ".github/workflows/release.yaml"), "utf8");
// Comments may name what is forbidden.
const code = readFileSync(path.join(root, ".github/workflows/release.yaml"), "utf8").replace(
    /^\s*#.*$/gm,
    "",
);
const publishSource = readFileSync(path.join(root, "tooling/release-publish.ts"), "utf8");

interface Step {
    name?: string;
    id?: string;
    uses?: string;
    run?: string;
    if?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
}
interface Job {
    needs?: string[];
    environment?: string;
    permissions?: Record<string, string>;
    steps: Step[];
    strategy?: { matrix: { include: { image: string }[] } };
    outputs?: Record<string, string>;
}
const wf = Bun.YAML.parse(file) as {
    on: Record<string, { tags?: string[] }>;
    permissions: Record<string, string>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<string, Job>;
};
const jobs = wf.jobs;
const steps = Object.entries(jobs).flatMap(([id, job]) => job.steps.map((step) => ({ id, step })));
const names = (id: string) => (jobs[id]!.steps ?? []).map((s) => s.uses ?? "");
const stepNamed = (id: string, text: string) =>
    jobs[id]!.steps.find((s) => (s.name ?? "").includes(text))!;

// GitHub's filter pattern glob, enough for the characters the trigger uses.
function globToRegExp(glob: string): RegExp {
    let source = "";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i]!;
        if (c === "[") {
            const end = glob.indexOf("]", i);
            if (end === -1) throw new Error(`unclosed [ in ${glob}`);
            source += glob.slice(i, end + 1);
            i = end;
        } else if (c === "+") source += "+";
        else if (c === "*") source += "[^/]*";
        else source += c.replace(/[.*+?^${}()|\\]/g, "\\$&");
    }
    return new RegExp(`^${source}$`);
}

describe("release workflow trigger", () => {
    it("starts only on a pushed v<semver>-like tag", () => {
        expect(Object.keys(wf.on)).toEqual(["push"]);
        expect(Object.keys(wf.on.push!)).toEqual(["tags"]);
        expect(wf.on.push!.tags).toEqual(["v[0-9]+.[0-9]+.[0-9]+*"]);
        expect(file).not.toMatch(/pull_request|schedule|workflow_dispatch|workflow_call/);
    });

    it("matches release tags and not package tags", () => {
        const glob = globToRegExp(wf.on.push!.tags![0]!);
        for (const tag of ["v0.1.0", "v0.1.0-rc.1", "v1.2.3garbage", "v1.2.3+build.5", "v10.0.0"]) {
            expect(glob.test(tag), tag).toBe(true);
        }
        for (const tag of ["core-v0.1.0", "@launchpad-kit/sdk-v0.1.0", "v1.2", "0.1.0"]) {
            expect(glob.test(tag), tag).toBe(false);
        }
    });

    it("runs one release at a time and never cancels one", () => {
        expect(wf.concurrency).toEqual({ group: "release", "cancel-in-progress": false });
    });
});

describe("release workflow job graph", () => {
    const table: Record<
        string,
        { needs: string[]; environment?: string; permissions: Record<string, string> }
    > = {
        guard: { needs: [], permissions: {} },
        verify: { needs: ["guard"], permissions: { contents: "read", checks: "read" } },
        build: { needs: ["guard", "verify"], permissions: { contents: "read" } },
        stage: {
            needs: ["guard", "build"],
            environment: "release",
            permissions: {
                contents: "read",
                packages: "write",
                "id-token": "write",
                attestations: "write",
                "artifact-metadata": "write",
            },
        },
        smoke: {
            needs: ["guard", "build", "stage"],
            permissions: { contents: "read", packages: "read" },
        },
        "npm-publish": {
            needs: ["guard", "build", "smoke"],
            environment: "release",
            permissions: { contents: "read", "id-token": "write" },
        },
        "image-publish": {
            needs: ["guard", "npm-publish"],
            environment: "release",
            permissions: { contents: "read", packages: "write" },
        },
        "post-verify": {
            needs: ["guard", "image-publish"],
            permissions: { contents: "read", packages: "read" },
        },
    };

    it("has exactly the jobs of the record, with its needs, environments and permissions", () => {
        expect(Object.keys(jobs).toSorted()).toEqual(Object.keys(table).toSorted());
        expect(wf.permissions).toEqual({});
        for (const [id, want] of Object.entries(table)) {
            const job = jobs[id]!;
            expect([...(job.needs ?? [])].toSorted(), `${id} needs`).toEqual(want.needs.toSorted());
            expect(job.environment, `${id} environment`).toBe(want.environment);
            expect(job.permissions, `${id} permissions`).toEqual(want.permissions);
        }
    });

    it("chains the jobs in the record's order", () => {
        const chain = [
            "guard",
            "verify",
            "build",
            "stage",
            "smoke",
            "npm-publish",
            "image-publish",
            "post-verify",
        ];
        const reaches = (from: string, to: string): boolean =>
            (jobs[from]!.needs ?? []).some((n) => n === to || reaches(n, to));
        for (let i = 1; i < chain.length; i++) {
            expect(reaches(chain[i]!, chain[i - 1]!), chain[i]).toBe(true);
            expect(reaches(chain[i]!, "guard")).toBe(true);
        }
        // Images are published only after npm.
        expect(jobs["image-publish"]!.needs).toContain("npm-publish");
    });

    it("grants each sensitive permission only where the record allows it", () => {
        const holders = (permission: string, level: string) =>
            Object.entries(jobs)
                .filter(([, job]) => job.permissions?.[permission] === level)
                .map(([id]) => id);
        expect(holders("id-token", "write")).toEqual(["stage", "npm-publish"]);
        expect(holders("attestations", "write")).toEqual(["stage"]);
        expect(holders("artifact-metadata", "write")).toEqual(["stage"]);
        expect(holders("packages", "write")).toEqual(["stage", "image-publish"]);
        expect(holders("packages", "read")).toEqual(["smoke", "post-verify"]);
    });
});

describe("release workflow tag guard", () => {
    const guard = stepNamed("guard", "Validate").run!;
    const pattern = /semver='([^']+)'/.exec(guard)![1]!;

    function guardOutcome(ref: string) {
        const out = path.join(mkdtempSync(path.join(tmpdir(), "guard-")), "output");
        writeFileSync(out, "");
        const done = spawnSync("bash", ["-e", "-c", guard], {
            env: { PATH: process.env.PATH!, REF_NAME: ref, GITHUB_OUTPUT: out },
            encoding: "utf8",
        });
        return { code: done.status, output: readFileSync(out, "utf8") };
    }

    it("uses the pattern of tooling/release-plan.ts", () => {
        expect(new RegExp(pattern).source).toBe(TAG_PATTERN.source);
    });

    it("validates github.ref_name from env, with no checkout", () => {
        expect(stepNamed("guard", "Validate").env).toEqual({ REF_NAME: "${{ github.ref_name }}" });
        expect(names("guard").filter(Boolean)).toEqual([]);
    });

    it("accepts release tags and outputs the version", () => {
        expect(guardOutcome("v0.1.0-rc.1")).toEqual({ code: 0, output: "version=0.1.0-rc.1\n" });
        expect(guardOutcome("v1.2.3-rc.12").code).toBe(0);
        expect(guardOutcome("v1.2.3")).toEqual({ code: 0, output: "version=1.2.3\n" });
    });

    it("refuses a pre-release that is not <registered channel>.<N>", () => {
        for (const ref of [
            "v1.2.3-rc-1",
            "v1.2.3-foo.1",
            "v1.2.3-rc",
            "v1.2.3-rc.01",
            "v1.2.3-rc.1.2",
            "v1.2.3-alpha.1",
            "v1.2.3-beta.1",
            "v1.2.3-RC.1",
        ]) {
            expect(guardOutcome(ref).code, ref).toBe(1);
        }
    });

    // The shell guard cannot import the registry, so its channel names and the kinds each
    // supports are read from its `case` and compared with the rows of tooling/release-channels.ts.
    it("lists in its case arms exactly the registry's pre-release channels and their kinds", () => {
        const arms = [...guard.matchAll(/^\s+([a-z]+)\) kinds="([^"]*)" ;;$/gm)].map((m) => [
            m[1]!,
            m[2]!.trim().split(/\s+/),
        ]);
        const rows = CHANNELS.filter((c) => c.preRelease !== null).map((c) => [
            c.preRelease!.replace(/^-/, "").replace(/\.N$/, ""),
            c.supports,
        ]);
        expect(arms).toEqual(rows);
    });

    it("agrees with checkTag on a table of tags", () => {
        const tags = [
            "v0.1.0",
            "v0.1.0-rc.1",
            "v0.2.1-rc.3",
            "v1.0.0-rc.0",
            "v1.0.0-rc.01",
            "v1.0.0-rc",
            "v1.0.0-rc.",
            "v1.0.0-rc.1.1",
            "v1.0.0-rc.a",
            "v1.0.0-rc-1",
            "v1.0.0-foo.1",
            "v1.0.0-alpha.1",
            "v1.0.0-beta.2",
            "v1.0.0-RC.1",
            "v1.0.0-nightly.20261128.abc1234",
            "v1.0.0-",
            "v1.0.0+build.5",
            "v01.0.0",
            "v1.2",
            `v1.2.3-rc.${"1".repeat(119)}`,
            `v1.2.3-rc.${"1".repeat(120)}`,
        ];
        for (const tag of tags) {
            expect(guardOutcome(tag).code === 0, tag).toBe(checkTag(tag).length === 0);
        }
    });

    it("agrees with the release kind rules for every channel", () => {
        const kindOf = (core: string): Kind => {
            const [, y, z] = core.split(".");
            return z !== "0" ? "patch" : y !== "0" ? "minor" : "major";
        };
        for (const c of CHANNELS.filter((row) => row.preRelease !== null)) {
            const name = c.preRelease!.replace(/^-/, "").replace(/\.N$/, "");
            for (const core of ["0.0.1", "0.1.0", "1.0.0", "1.2.3", "2.0.0"]) {
                const tag = `v${core}-${name}.1`;
                const supported = c.supports.includes(kindOf(core));
                expect(guardOutcome(tag).code === 0, tag).toBe(supported);
                expect(checkTag(tag).length === 0, tag).toBe(supported);
            }
        }
    });

    it("rejects build metadata, leading zeros and trailing text", () => {
        for (const ref of ["v1.2.3+build.5", "v01.2.3", "v1.2.3garbage"]) {
            expect(guardOutcome(ref).code, ref).toBe(1);
        }
    });

    it("rejects a version longer than 128 characters", () => {
        expect(guardOutcome(`v1.2.3-rc.${"1".repeat(119)}`).code).toBe(0);
        expect(guardOutcome(`v1.2.3-rc.${"1".repeat(120)}`).code).toBe(1);
    });
});

describe("release workflow verification", () => {
    const runs = jobs.verify!.steps.map((s) => s.run ?? "").join("\n");

    it("checks the tag, the branch, CI Passed, the partial-release rule and the gate", () => {
        expect(runs).toContain('release-plan.ts guard "$TAG"');
        expect(runs).toContain('release-plan.ts verify-tag "$TAG"');
        expect(runs).toContain('release-plan.ts no-regression "$VERSION" --require-tag');
        expect(runs).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
        expect(runs).toMatch(/check-runs/);
        expect(runs).toContain("release-plan.ts ci-passed");
        expect(runs).toContain('release-plan.ts partial "$VERSION"');
        expect(runs).toContain("omni -i run check test build check:compose");
        expect(runs).toContain("release:dry-run");
        expect(runs.match(/omni -i run test:packages/g)).toHaveLength(2);
        const checkout = jobs.verify!.steps.find((s) => s.uses?.startsWith("actions/checkout"));
        expect(checkout?.with?.["fetch-depth"]).toBe(0);
    });

    it("hands the tarballs over by checksum, never rebuilding them", () => {
        expect(jobs.build!.outputs).toEqual({ sums: "${{ steps.sums.outputs.sha256 }}" });
        for (const id of ["smoke", "npm-publish"]) {
            expect(jobs[id]!.steps.map((s) => s.run ?? "").join("\n"), id).toContain(
                '[ "$(sha256sum SHA256SUMS | cut -d\' \' -f1)" = "$SUMS" ]',
            );
            expect(jobs[id]!.steps.map((s) => s.run ?? "").join("\n"), id).toContain(
                "sha256sum -c SHA256SUMS",
            );
        }
        for (const id of ["smoke", "npm-publish"]) {
            expect(runsOf(id)).not.toMatch(/release:dry-run|bun pm pack|omni -i run build/);
        }
    });
});

const runsOf = (id: string) => jobs[id]!.steps.map((s) => s.run ?? "").join("\n");

describe("release workflow credentials and injection", () => {
    it("uses no secret but the automatic token, and no token for npm", () => {
        expect(file).not.toMatch(/secrets\.|NODE_AUTH_TOKEN|NPM_TOKEN|_authToken|registry-url/);
        expect(
            file.match(/\$\{\{\s*[^}]*\btoken\b[^}]*\}\}/g)!.every((m) => /github\.token/.test(m)),
        ).toBe(true);
    });

    it("never interpolates an expression into a run block", () => {
        for (const { id, step } of steps) {
            expect(step.run ?? "", `${id}: ${step.name}`).not.toContain("${{");
        }
    });

    it("pins every action by full commit SHA with the version in a comment", () => {
        const uses = file.split("\n").filter((line) => /^\s*(- )?uses:/.test(line));
        expect(uses.length).toBeGreaterThan(10);
        for (const line of uses) {
            expect(line, line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/);
        }
    });

    it("restores no cache", () => {
        expect(code).not.toMatch(
            /actions\/cache|setup-omni|setup-workspace|cache-from|cache-to|restore-keys/,
        );
        for (const { id, step } of steps) {
            if (step.uses?.startsWith("actions/setup-node")) {
                expect(step.with?.["package-manager-cache"], id).toBe(false);
                expect(step.with?.cache, id).toBeUndefined();
            }
            if (step.uses?.startsWith("oven-sh/setup-bun"))
                expect(step.with?.["no-cache"], id).toBe(true);
        }
    });

    it("installs the same Omni version as the setup action, from a checked release", () => {
        const action = Bun.YAML.parse(
            readFileSync(path.join(root, ".github/actions/setup-workspace/action.yaml"), "utf8"),
        ) as { inputs: Record<string, { default?: string }> };
        const env = (Bun.YAML.parse(file) as { env: Record<string, string> }).env;
        expect(env.OMNI_VERSION).toBe(action.inputs["omni-version"]!.default!);
        expect(env.OMNI_SHA256).toMatch(/^[0-9a-f]{64}$/);
        expect(stepNamed("verify", "Install Omni").run).toContain("sha256sum -c -");
    });
});

describe("release workflow npm", () => {
    it("publishes with npm only, on Node 24 with the npm minimum checked", () => {
        expect(file).not.toMatch(/bun publish|yarn publish|pnpm publish|npm stage/);
        expect(publishSource).toMatch(
            /must\("npm", \["publish", tarball, "--tag", tag, "--provenance"/,
        );
        expect(publishSource).not.toMatch(/"bun", \["publish|bun publish/);
        const node = jobs["npm-publish"]!.steps.find((s) =>
            s.uses?.startsWith("actions/setup-node"),
        );
        expect(node?.with?.["node-version"]).toBe("24");
        const check = stepNamed("npm-publish", "minimums").run!;
        expect(check).toContain("22, 14, 0");
        expect(check).toContain("11, 5, 1");
        expect(jobs["npm-publish"]!.permissions).toEqual({ contents: "read", "id-token": "write" });
        expect(runsOf("npm-publish")).toContain(
            'release-publish.ts publish-npm packages "$VERSION"',
        );
    });

    it("publishes in dependency order and chooses the tag per package", () => {
        expect(readFileSync(path.join(root, "tooling/release-core.ts"), "utf8")).toContain(
            '["contracts", "sdk", "client-core", "cli", "mcp"]',
        );
        expect(publishSource).toContain("for (const name of PUBLISH_ORDER)");
        expect(publishSource).toContain("npmDistTag(version, tagOnNpm(name, channelTag))");
    });
});

describe("release workflow images", () => {
    const matrix = jobs.stage!.strategy!.matrix.include;

    it("covers the five images", () => {
        expect(matrix.map((m) => m.image)).toEqual(IMAGES);
    });

    it("builds once under sha-<GITHUB_SHA>, pushed, with BuildKit attestations, and reuses an existing tag", () => {
        const build = jobs.stage!.steps.find((s) =>
            s.uses?.startsWith("docker/build-push-action"),
        )!;
        expect(build.with?.tags).toBe(
            "ghcr.io/launchpad-kit/launchpad-${{ matrix.image }}:sha-${{ github.sha }}",
        );
        expect(build.with).toMatchObject({ push: true, provenance: "mode=max", sbom: true });
        expect(build.with).not.toHaveProperty("load");
        expect(build.if).toBe("steps.existing.outputs.found != 'true'");
        expect(runsOf("stage")).toContain('image-digest "$IMAGE" "sha-$GITHUB_SHA"');
    });

    it("attests each staged digest with a signed GitHub attestation", () => {
        const stepsOfStage = jobs.stage!.steps;
        const attest = stepsOfStage.find((s) => s.uses?.startsWith("actions/attest@"))!;
        expect(attest.with).toEqual({
            "subject-name": "ghcr.io/launchpad-kit/launchpad-${{ matrix.image }}",
            "subject-digest": "${{ steps.digest.outputs.digest }}",
            "push-to-registry": true,
        });
        expect(stepsOfStage.indexOf(attest)).toBeGreaterThan(
            stepsOfStage.findIndex((s) => s.uses?.startsWith("docker/build-push-action")),
        );
    });

    it("only retags after npm, and never builds in the image-publish job", () => {
        expect(names("image-publish").join(" ")).not.toMatch(/build-push|buildx/);
        expect(runsOf("image-publish")).not.toMatch(/docker build|buildx build/);
        expect(runsOf("image-publish")).toContain("release-publish.ts retag");
        expect(publishSource).toMatch(/"imagetools",\s*"create",\s*"-t"/);
    });

    it("smokes the exact staged digest", () => {
        expect(runsOf("smoke")).toContain('@$(cat "staged/$name.txt")');
        expect(runsOf("smoke")).toContain('[ "$(label version)" = "$VERSION" ]');
    });
});

describe("release workflow post-verify", () => {
    it("verifies attestations and signatures with read access only", () => {
        expect(jobs["post-verify"]!.permissions).toEqual({ contents: "read", packages: "read" });
        expect(jobs["post-verify"]!.environment).toBeUndefined();
        expect(runsOf("post-verify")).toContain("gh attestation verify");
        expect(runsOf("post-verify")).toContain("npm audit signatures");
    });
});

describe("release workflow credentialed jobs install nothing", () => {
    // An allowlist: the credentialed jobs run exactly these commands and use exactly these actions.
    // Anything added (an install, bunx, a download piped to a shell, another script) fails here.
    const ALLOWED_RUNS: Record<string, string[]> = {
        stage: [
            'code=0\ndigest=$(bun --no-install tooling/release-publish.ts image-digest "$IMAGE" "sha-$GITHUB_SHA") || code=$?\ncase "$code" in\n  0) echo "found=true" >> "$GITHUB_OUTPUT"; echo "digest=$digest" >> "$GITHUB_OUTPUT" ;;\n  3) echo "found=false" >> "$GITHUB_OUTPUT" ;;\n  *) exit "$code" ;;\nesac',
            'echo "created=$(git show -s --format=%cI "$GITHUB_SHA")" >> "$GITHUB_OUTPUT"',
            'digest="${EXISTING:-$BUILT}"\n[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "::error::no staged digest"; exit 1; }\necho "digest=$digest" >> "$GITHUB_OUTPUT"\nmkdir staged\necho "$digest" > "staged/$IMAGE.txt"',
            'gh attestation verify "oci://ghcr.io/launchpad-kit/launchpad-$IMAGE@$DIGEST" \\\n  --repo "$GITHUB_REPOSITORY" \\\n  --signer-workflow launchpad-kit/launchpad/.github/workflows/release.yaml \\\n  --source-ref "refs/tags/v$VERSION"',
        ],
        "npm-publish": [
            'npm --version\nnode -e \'const at = (v, ...min) => { const p = v.split(".").map(Number); for (let i = 0; i < 3; i++) { if (p[i] !== min[i]) return p[i] > min[i]; } return true; }; if (!at(process.versions.node, 22, 14, 0) || !at(process.argv[1], 11, 5, 1)) process.exit(1)\' "$(npm --version)"',
            '[ "$(sha256sum SHA256SUMS | cut -d\' \' -f1)" = "$SUMS" ]\nsha256sum -c SHA256SUMS',
            'bun --no-install tooling/release-publish.ts publish-npm packages "$VERSION"',
        ],
        "image-publish": [
            'for name in controller worker router admin dokku; do\n  gh attestation verify "oci://ghcr.io/launchpad-kit/launchpad-$name@$(cat "staged/$name.txt")" \\\n    --repo "$GITHUB_REPOSITORY" \\\n    --signer-workflow launchpad-kit/launchpad/.github/workflows/release.yaml \\\n    --source-ref "refs/tags/v$VERSION"\ndone',
            'for name in controller worker router admin dokku; do\n  bun --no-install tooling/release-publish.ts retag "$name" "$VERSION" "$(cat "staged/$name.txt")" "$GITHUB_SHA"\ndone',
        ],
    };
    const ALLOWED_USES: Record<string, string[]> = {
        stage: [
            "actions/checkout",
            "oven-sh/setup-bun",
            "docker/login-action",
            "docker/setup-buildx-action",
            "docker/build-push-action",
            "actions/attest",
            "actions/upload-artifact",
        ],
        "npm-publish": [
            "actions/checkout",
            "oven-sh/setup-bun",
            "actions/setup-node",
            "actions/download-artifact",
        ],
        "image-publish": [
            "actions/checkout",
            "oven-sh/setup-bun",
            "docker/login-action",
            "actions/download-artifact",
        ],
    };

    it("run only allowlisted commands and actions in the jobs with the OIDC token or registry write", () => {
        for (const id of Object.keys(ALLOWED_RUNS)) {
            const used = jobs[id]!.steps.filter((s) => s.run !== undefined).map((s) =>
                s.run!.trim(),
            );
            expect(used, id).toEqual(ALLOWED_RUNS[id]!);
            const actions = jobs[id]!.steps.filter((s) => s.uses !== undefined).map(
                (s) => s.uses!.split("@")[0]!,
            );
            expect(actions.toSorted(), id).toEqual(ALLOWED_USES[id]!.toSorted());
        }
    });

    it("run the publish script without Bun's runtime auto-install, in every credentialed job", () => {
        for (const id of ["stage", "npm-publish", "image-publish", "post-verify"]) {
            const text = runsOf(id);
            for (const [, flag] of text.matchAll(/\bbun (\S+)/g))
                expect(flag, id).toBe("--no-install");
            for (const [, script] of text.matchAll(/bun --no-install tooling\/(\S+)/g)) {
                expect(script, id).toBe("release-publish.ts");
            }
            expect(text, id).not.toMatch(
                /\b(bunx|npx|yarn|pnpm)\b|curl|wget|bun run|bun x|bun install|bun add|tooling\/versions/,
            );
        }
        // npm install is for the consumer projects of smoke and post-verify only.
        for (const id of ["stage", "npm-publish", "image-publish"]) {
            expect(runsOf(id), id).not.toMatch(/\bnpm (install|i|ci|add|exec)\b/);
        }
        expect(code).not.toMatch(/bun tooling\/release-publish/);
    });

    // Every module specifier the publish script can load, however it is written.
    function specifiers(source: string): string[] {
        const found = new Set<string>(
            new Bun.Transpiler({ loader: "ts" }).scanImports(source).map((i) => i.path),
        );
        for (const m of source.matchAll(/\b(?:from|import|require)\s*\(?\s*(["'`])([^"'`]+)\1/g)) {
            found.add(m[2]!);
        }
        // A dynamic specifier cannot be checked, so it is refused.
        expect(source).not.toMatch(/\b(?:import|require)\s*\(\s*[^"'`\s)]/);
        return [...found];
    }

    it("run scripts that import only node: built-ins and dependency-free relative modules", () => {
        const seen = new Set<string>();
        const visit = (name: string) => {
            if (seen.has(name)) return;
            seen.add(name);
            const source = readFileSync(path.join(root, "tooling", `${name}.ts`), "utf8");
            for (const specifier of specifiers(source)) {
                if (specifier.startsWith("node:")) continue;
                expect(specifier, `${name}.ts`).toMatch(/^\.\/[a-z-]+$/);
                visit(specifier.slice(2));
            }
        };
        visit("release-publish");
        // Deliberately exactly these: a new import into the credentialed jobs is a decision.
        expect([...seen].toSorted()).toEqual([
            "release-channels",
            "release-core",
            "release-publish",
            "semver-compare",
        ]);
    });

    it("scans imports whatever the quoting", () => {
        const source =
            "import a from 'x'; import(`y`); import('z'); const q = require('w'); import 'v';";
        expect(specifiers(source).toSorted()).toEqual(["v", "w", "x", "y", "z"]);
    });

    it("verify attestations of the staged digests before image-publish retags", () => {
        const text = runsOf("image-publish");
        expect(text.indexOf("gh attestation verify")).toBeGreaterThan(-1);
        expect(text.indexOf("gh attestation verify")).toBeLessThan(
            text.indexOf("release-publish.ts retag"),
        );
    });

    it("pin the signer workflow and the tag ref when verifying attestations", () => {
        for (const id of ["image-publish", "post-verify"]) {
            expect(runsOf(id), id).toContain(
                "--signer-workflow launchpad-kit/launchpad/.github/workflows/release.yaml",
            );
            expect(runsOf(id), id).toContain('--source-ref "refs/tags/v$VERSION"');
        }
    });

    it("retries the install of just-published packages, boundedly", () => {
        expect(runsOf("post-verify")).toMatch(/for attempt in 1 2 3 4 5 6; do[\s\S]*sleep 20/);
    });
});

describe("release workflow fails closed", () => {
    const everyStep = Object.entries(jobs).flatMap(([id, job]) =>
        job.steps.map((step) => ({ id, step })),
    );

    it("has no continue-on-error anywhere", () => {
        expect(code).not.toContain("continue-on-error");
        expect(code).not.toMatch(/\|\| true|set \+e/);
    });

    it("has no conditional job and three benign conditional steps in stage", () => {
        for (const [id, job] of Object.entries(jobs)) {
            expect((job as { if?: string }).if, id).toBeUndefined();
        }
        const conditional = everyStep.filter(({ step }) => step.if !== undefined);
        expect(conditional.map(({ id, step }) => [id, step.if])).toEqual([
            ["stage", "steps.existing.outputs.found != 'true'"],
            ["stage", "steps.existing.outputs.found == 'true'"],
            ["stage", "steps.existing.outputs.found != 'true'"],
        ]);
    });

    it("checks out the tagged commit only, without keeping credentials", () => {
        const checkouts = everyStep.filter(({ step }) =>
            step.uses?.startsWith("actions/checkout@"),
        );
        expect(checkouts).toHaveLength(Object.keys(jobs).length - 1);
        for (const { id, step } of checkouts) {
            expect(step.with?.["persist-credentials"], id).toBe(false);
            expect(step.with?.ref, id).toBe("${{ github.sha }}");
        }
    });

    it("gives GH_TOKEN to the gh steps only", () => {
        for (const [id, job] of Object.entries(jobs)) {
            expect((job as { env?: Record<string, string> }).env?.GH_TOKEN, id).toBeUndefined();
        }
        for (const { id, step } of everyStep) {
            if (/\bgh /.test(step.run ?? ""))
                expect(step.env?.GH_TOKEN, `${id}: ${step.name}`).toBe("${{ github.token }}");
        }
    });
});

describe("release workflow environment, shell and fallbacks", () => {
    it("has no workflow-level env but the pinned Omni pair", () => {
        const env = (Bun.YAML.parse(file) as { env: Record<string, string> }).env;
        expect(Object.keys(env).toSorted()).toEqual(["OMNI_SHA256", "OMNI_VERSION"]);
    });

    it("runs every step in bash, set once at the workflow level", () => {
        const defaults = (Bun.YAML.parse(file) as { defaults: { run: { shell: string } } })
            .defaults;
        expect(defaults.run.shell).toBe("bash");
    });

    it("uses no || fallback in the image-publish and post-verify commands", () => {
        for (const id of ["image-publish", "post-verify"])
            expect(runsOf(id), id).not.toContain("||");
    });

    it("verifies a reused staged image's attestation and attests only a fresh build", () => {
        const stage = jobs.stage!.steps;
        const verify = stage.find((s) => s.name === "Verify the existing attestation")!;
        expect(verify.if).toBe("steps.existing.outputs.found == 'true'");
        expect(verify.run).toContain("gh attestation verify");
        expect(verify.run).toContain(
            "--signer-workflow launchpad-kit/launchpad/.github/workflows/release.yaml",
        );
        const attest = stage.find((s) => s.uses?.startsWith("actions/attest@"))!;
        expect(attest.if).toBe("steps.existing.outputs.found != 'true'");
    });
});

describe("release workflow artifacts and cache-like inputs", () => {
    it("keeps the tarballs and staged digests for the whole 30-day retry window", () => {
        const uploads = steps.filter(({ step }) =>
            step.uses?.startsWith("actions/upload-artifact@"),
        );
        expect(uploads.map(({ id }) => id).toSorted()).toEqual(["build", "stage"]);
        for (const { id, step } of uploads) {
            expect(step.with?.["retention-days"], id).toBe(30);
        }
    });

    // Every input of a pinned action that can restore or save a cache, as read from its action.yml
    // at the pinned SHA: setup-node `package-manager-cache` (default true), setup-bun `no-cache`
    // (default false), setup-buildx `cache-binary` (default true), build-push `cache-from` and
    // `cache-to` (unset by default, never given here).
    it("turns off every cache an action would otherwise use", () => {
        const buildx = steps.filter(({ step }) =>
            step.uses?.startsWith("docker/setup-buildx-action@"),
        );
        expect(buildx.length).toBeGreaterThan(0);
        for (const { id, step } of buildx) expect(step.with?.["cache-binary"], id).toBe(false);
        for (const { id, step } of steps) {
            for (const input of Object.keys(step.with ?? {})) {
                if (!/cache/i.test(input)) continue;
                expect(
                    ["package-manager-cache", "no-cache", "cache-binary"],
                    `${id}: ${step.uses} ${input}`,
                ).toContain(input);
            }
        }
    });
});

describe("the tag glob matcher", () => {
    it("rejects an unclosed character class instead of looping", () => {
        expect(() => globToRegExp("v[0-9+.[0-9]+")).not.toThrow();
        expect(() => globToRegExp("v[0-9")).toThrow(/unclosed/);
        expect(globToRegExp("v[0-9]+").test("v10")).toBe(true);
    });
});

describe("release workflow orders its risks before npm publishes", () => {
    it("verifies the staged attestations in smoke, which runs before npm-publish", () => {
        expect(jobs["npm-publish"]!.needs).toContain("smoke");
        expect(runsOf("smoke")).toContain("gh attestation verify");
        expect(runsOf("smoke")).toContain(
            "--signer-workflow launchpad-kit/launchpad/.github/workflows/release.yaml",
        );
        expect(runsOf("smoke")).toContain('--source-ref "refs/tags/v$VERSION"');
    });
});
