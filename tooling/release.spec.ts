import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IMAGES, TAG_PATTERN } from "./release-plan";

const root = path.resolve(import.meta.dirname, "..");
const file = readFileSync(path.join(root, ".github/workflows/release.yaml"), "utf8");
// Comments may name what is forbidden.
const code = readFileSync(path.join(root, ".github/workflows/release.yaml"), "utf8").replace(
    /^\s*#.*$/gm,
    "",
);
const planSource = readFileSync(path.join(root, "tooling/release-plan.ts"), "utf8");

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
        expect(guardOutcome("v1.2.3-rc-1").code).toBe(0);
    });

    it("rejects build metadata, leading zeros and trailing text", () => {
        for (const ref of ["v1.2.3+build.5", "v01.2.3", "v1.2.3garbage"]) {
            expect(guardOutcome(ref).code, ref).toBe(1);
        }
    });

    it("rejects a version longer than 128 characters", () => {
        expect(guardOutcome(`v1.2.3-${"a".repeat(122)}`).code).toBe(0);
        expect(guardOutcome(`v1.2.3-${"a".repeat(123)}`).code).toBe(1);
    });
});

describe("release workflow verification", () => {
    const runs = jobs.verify!.steps.map((s) => s.run ?? "").join("\n");

    it("checks the tag, the branch, CI Passed, the partial-release rule and the gate", () => {
        expect(runs).toContain('release-plan.ts guard "$TAG"');
        expect(runs).toContain('release-plan.ts verify-tag "$TAG"');
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
        expect(planSource).toMatch(
            /must\("npm", \["publish", tarball, "--tag", tag, "--provenance"/,
        );
        expect(planSource).not.toMatch(/"bun", \["publish|bun publish/);
        const node = jobs["npm-publish"]!.steps.find((s) =>
            s.uses?.startsWith("actions/setup-node"),
        );
        expect(node?.with?.["node-version"]).toBe("24");
        const check = stepNamed("npm-publish", "minimums").run!;
        expect(check).toContain("22, 14, 0");
        expect(check).toContain("11, 5, 1");
        expect(jobs["npm-publish"]!.permissions).toEqual({ contents: "read", "id-token": "write" });
        expect(runsOf("npm-publish")).toContain('release-plan.ts publish-npm packages "$VERSION"');
    });

    it("publishes in dependency order and chooses the tag per package", () => {
        expect(planSource).toContain('["contracts", "sdk", "client-core", "cli", "mcp"]');
        expect(planSource).toContain("npmDistTag(version, latestOnNpm(name))");
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
        expect(runsOf("image-publish")).toContain("release-plan.ts retag");
        expect(planSource).toMatch(/"imagetools", "create", "-t"/);
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
