import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createContext } from "@launchpad/client-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "./errors";
import type { Io } from "./io";
import { run } from "./program";

const KEY = "lp_" + "a".repeat(43);
const ORG = "org-one";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const PREVIEW = "22222222-2222-4222-8222-222222222222";
const ARTIFACT = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT = "44444444-4444-4444-8444-444444444444";
const NOW = "2026-11-15T00:00:00.000Z";
const HOST = "review-a1b2c3.previews.example.com";
let dir = "";

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const preview = {
    id: PREVIEW,
    projectId: PROJECT,
    slug: "review",
    hostname: HOST,
    state: "active",
    activeDeploymentId: null,
    createdAt: NOW,
};
const deployment = (status: string, failure: unknown = null) => ({
    id: DEPLOYMENT,
    previewId: PREVIEW,
    artifactId: ARTIFACT,
    spa: false,
    status,
    failure,
    createdAt: NOW,
    updatedAt: NOW,
    finishedAt: null,
});

// A controller that answers deployments from a list of statuses.
function controller(options: { statuses: string[]; failure?: unknown; denyUpload?: boolean }) {
    let polled = 0;
    return (async (url: string, init: RequestInit) => {
        const u = new URL(url);
        const p = u.pathname.replace("/api/v1", "");
        const method = init.method ?? "GET";
        if (p === "/key") {
            return json({
                id: PROJECT,
                name: "ci",
                organizationId: ORG,
                scopes: [],
                projectIds: null,
                expiresAt: NOW,
            });
        }
        if (p === `/organizations/${ORG}/projects`) {
            return json([{ id: PROJECT, slug: "site", name: "Site", createdAt: NOW }]);
        }
        if (p === `/organizations/${ORG}/artifacts`) {
            if (options.denyUpload) {
                return json(
                    {
                        code: "forbidden",
                        status: 403,
                        title: "This API key does not have that permission.",
                    },
                    403,
                );
            }
            return json(
                {
                    id: ARTIFACT,
                    digest: "a".repeat(64),
                    sizeBytes: 9,
                    expandedBytes: 9,
                    entryCount: 1,
                    createdAt: NOW,
                    reused: false,
                },
                201,
            );
        }
        if (p === `/organizations/${ORG}/previews` && method === "GET") {
            return json({ items: [preview], nextCursor: null });
        }
        if (p === `/organizations/${ORG}/previews/${PREVIEW}`) return json(preview);
        if (p === `/organizations/${ORG}/previews/${PREVIEW}/deployments`) {
            return method === "POST"
                ? json({ id: DEPLOYMENT, status: "queued", createdAt: NOW }, 202)
                : json({ items: [deployment("succeeded")] });
        }
        if (p === `/organizations/${ORG}/deployments/${DEPLOYMENT}/events`) {
            return json({
                items: [
                    {
                        seq: 1,
                        phase: "build",
                        level: "info",
                        message: "Starting build.",
                        createdAt: NOW,
                    },
                ],
                nextAfter: null,
            });
        }
        if (p === `/organizations/${ORG}/deployments/${DEPLOYMENT}`) {
            const status = options.statuses[Math.min(polled++, options.statuses.length - 1)]!;
            return json(deployment(status, status === "failed" ? options.failure : null));
        }
        return json({ code: "not-found", status: 404, title: "Not Found" }, 404);
    }) as unknown as typeof fetch;
}

async function cli(args: string[], fetchImpl: typeof fetch) {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = {
        context: createContext(
            {
                LAUNCHPAD_CONFIG_DIR: dir,
                LAUNCHPAD_CONTROLLER: "https://control.example.com",
                LAUNCHPAD_API_KEY: KEY,
            },
            { fetch: fetchImpl },
        ),
        out: (t) => void out.push(t),
        err: (t) => void err.push(t),
        interactive: false,
        readSecret: async () => "",
        readStdin: async () => "",
        readFile: async () => {
            throw new Error("ENOENT");
        },
    };
    const code = await run(args, io);
    return { code, out: out.join("\n"), err: err.join("\n") };
}

let site = "";
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "launchpad-cli-deploy-"));
    site = path.join(dir, "dist");
    await fs.mkdir(site);
    await fs.writeFile(path.join(site, "index.html"), "<p>hi</p>");
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

const deployArgs = (...extra: string[]) => [
    "deploy",
    site,
    "--project",
    "site",
    "--name",
    "review",
    ...extra,
];

describe("launchpad deploy", () => {
    it("deploys, shows progress on stderr and the result on stdout, and exits 0", async () => {
        const result = await cli(deployArgs("--spa"), controller({ statuses: ["succeeded"] }));
        expect(result.code).toBe(EXIT.ok);
        expect(result.out).toBe(`Deployed ${HOST} (deployment ${DEPLOYMENT}).`);
        expect(result.err).toContain("Packing the site");
        expect(result.err).toContain("Status: succeeded");
        expect(result.err).toContain("[build] Starting build.");
    });

    it("prints exactly one JSON document and no progress with --json", async () => {
        const result = await cli(
            ["--json", ...deployArgs()],
            controller({ statuses: ["succeeded"] }),
        );
        expect(result.code).toBe(EXIT.ok);
        expect(result.err).toBe("");
        const parsed = JSON.parse(result.out);
        expect(parsed).toMatchObject({
            outcome: "succeeded",
            preview: { id: PREVIEW, hostname: HOST },
            artifact: { id: ARTIFACT },
            deployment: { id: DEPLOYMENT, status: "succeeded" },
        });
        expect(result.out).not.toContain(KEY);
    });

    it("exits 7 with the safe failure when the deployment failed, and 7 when it needs an administrator", async () => {
        const failure = {
            code: "verify-failed-rolled-back",
            message: "The new release did not become ready; the previous one was restored.",
        };
        const failed = await cli(deployArgs(), controller({ statuses: ["failed"], failure }));
        expect(failed.code).toBe(EXIT.deployment);
        expect(failed.out).toContain(`Deployment ${DEPLOYMENT} failed: ${failure.message}`);
        const held = await cli(deployArgs(), controller({ statuses: ["reconciliation-needed"] }));
        expect(held.code).toBe(EXIT.deployment);
        expect(held.out).toContain("needs an administrator");
        const asJson = await cli(
            ["--json", ...deployArgs()],
            controller({ statuses: ["failed"], failure }),
        );
        expect(asJson.code).toBe(EXIT.deployment);
        expect(JSON.parse(asJson.out).deployment.failure).toEqual(failure);
        expect(asJson.err).toBe("");
    });

    it("exits 0 for --no-wait, and 8 when the wait runs out", async () => {
        const queued = await cli(deployArgs("--no-wait"), controller({ statuses: ["queued"] }));
        expect(queued.code).toBe(EXIT.ok);
        expect(queued.out).toContain("launchpad deployments status");
        const slow = await cli(
            deployArgs("--timeout", "1"),
            controller({ statuses: ["building"] }),
        );
        expect(slow.code).toBe(EXIT.waiting);
        expect(slow.out).toContain("it was not cancelled");
    });

    it("maps a permission failure to 3 and bad input to 2", async () => {
        const denied = await cli(
            deployArgs(),
            controller({ statuses: ["succeeded"], denyUpload: true }),
        );
        expect(denied.code).toBe(EXIT.unauthorized);
        expect(denied.err).toContain("does not have that permission");
        expect((await cli(deployArgs("--timeout", "0"), controller({ statuses: [] }))).code).toBe(
            EXIT.usage,
        );
        expect(
            (await cli(["deploy", site, "--project", "site"], controller({ statuses: [] }))).code,
        ).toBe(EXIT.usage);
        const secret = path.join(site, ".env");
        await fs.writeFile(secret, "X=1");
        const refused = await cli(deployArgs(), controller({ statuses: [] }));
        expect(refused.code).toBe(EXIT.usage);
        expect(refused.err).toMatch(/secret/);
    });
});

describe("previews and deployments", () => {
    it("lists previews, shows one with its history, and reads a deployment and its events", async () => {
        const fetchImpl = controller({ statuses: ["succeeded"] });
        const list = await cli(["previews", "list", "--project", "site"], fetchImpl);
        expect(list.code).toBe(EXIT.ok);
        expect(list.out).toContain(HOST);
        const one = await cli(["previews", "get", PREVIEW], fetchImpl);
        expect(one.out).toContain(`Hostname: ${HOST}`);
        expect(one.out).toContain(DEPLOYMENT);
        const status = await cli(["deployments", "status", DEPLOYMENT], fetchImpl);
        expect(status.out).toContain("Status:     succeeded");
        const events = await cli(
            ["--json", "deployments", "events", DEPLOYMENT, "--after", "0"],
            fetchImpl,
        );
        expect(JSON.parse(events.out).items[0]).toMatchObject({ seq: 1, phase: "build" });
        expect(
            (await cli(["deployments", "events", DEPLOYMENT, "--after", "-1"], fetchImpl)).code,
        ).toBe(EXIT.usage);
        const missing = await cli(
            ["deployments", "status", "00000000-0000-4000-8000-000000000000"],
            fetchImpl,
        );
        expect(missing.code).toBe(EXIT.notFound);
    });
});
