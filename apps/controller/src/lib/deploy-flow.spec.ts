import { describe, expect, it } from "vitest";
import type { ApiResult } from "./api";
import {
    afterFailure,
    checkDeployForm,
    fieldsLocked,
    newResume,
    runDeploy,
    withNewFile,
    withNewSpa,
    type Call,
} from "./deploy-flow";

const MIB = 1024 * 1024;

describe("checking the form before sending", () => {
    const ok = {
        needsName: true,
        name: "my-site",
        file: { name: "site.tar.gz", size: 100 },
        maxBytes: 50 * MIB,
    };
    it("accepts a good form, and a .tgz", () => {
        expect(checkDeployForm(ok)).toEqual([]);
        expect(checkDeployForm({ ...ok, file: { name: "SITE.TGZ", size: 1 } })).toEqual([]);
    });
    it("names every problem", () => {
        expect(checkDeployForm({ ...ok, name: "Bad Name" })).toHaveLength(1);
        expect(checkDeployForm({ ...ok, name: "-x" })).toHaveLength(1);
        expect(checkDeployForm({ ...ok, name: "a".repeat(41) })).toHaveLength(1);
        expect(checkDeployForm({ ...ok, file: null })).toHaveLength(1);
        expect(checkDeployForm({ ...ok, file: { name: "site.zip", size: 5 } })).toHaveLength(1);
        expect(checkDeployForm({ ...ok, file: { name: "a.tar.gz", size: 0 } })).toHaveLength(1);
        expect(checkDeployForm({ ...ok, file: { name: "a.tar.gz", size: 51 * MIB } })[0]).toContain(
            "50 MiB",
        );
        expect(checkDeployForm({ ...ok, name: "", file: null })).toHaveLength(2);
        // A name is not needed for an existing preview.
        expect(checkDeployForm({ ...ok, needsName: false, name: "" })).toEqual([]);
    });
});

interface Sent {
    method: string;
    path: string;
    json?: unknown;
    raw?: { contentType: string };
    key?: string;
}

function fake(answers: Record<string, ApiResult<unknown>[]>) {
    const sent: Sent[] = [];
    const call: Call = async <T>(
        method: string,
        path: string,
        options: Parameters<Call>[2] = {},
    ) => {
        sent.push({
            method,
            path,
            json: options.json,
            raw: options.raw && { contentType: options.raw.contentType },
            key: options.headers?.["idempotency-key"],
        });
        const route = path.replace(/[0-9a-f-]{36}/g, ":id");
        const queue = answers[`${method} ${route}`] ?? [];
        return (queue.shift() ?? {
            ok: false,
            message: "unexpected call",
            status: 500,
        }) as ApiResult<T>;
    };
    return { sent, call };
}
const yes = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const no = (message: string, status = 409): ApiResult<never> => ({ ok: false, message, status });
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const file = new Blob(["x"]);

describe("deploying from the dashboard", () => {
    it("creates the preview, uploads the archive and queues the deployment, in that order", async () => {
        const { sent, call } = fake({
            "POST /organizations/org/projects/:id/previews": [yes({ id: ID(2) })],
            "POST /organizations/org/artifacts": [yes({ id: ID(3) })],
            "POST /organizations/org/previews/:id/deployments": [yes({ id: ID(4) })],
        });
        const steps: string[] = [];
        const resume = newResume();
        const result = await runDeploy({
            call,
            organizationId: "org",
            file,
            spa: true,
            resume,
            create: { projectId: ID(1), slug: "site", ttl: "24h" },
            onStep: (s) => steps.push(s),
        });
        expect(result).toEqual({ ok: true, previewId: ID(2), deploymentId: ID(4) });
        expect(steps).toEqual(["create", "upload", "deploy"]);
        expect(sent[0]).toMatchObject({
            json: { slug: "site", ttl: "24h" },
            key: resume.createKey,
        });
        expect(sent[1]).toMatchObject({ raw: { contentType: "application/gzip" } });
        expect(sent[2]).toMatchObject({
            json: { artifactId: ID(3), spa: true },
            key: resume.deployKey,
        });
        expect(resume.createKey).not.toBe(resume.deployKey);
    });

    it("leaves the lifetime out unless one was chosen, and skips creating for an existing preview", async () => {
        const { sent, call } = fake({
            "POST /organizations/org/artifacts": [yes({ id: ID(3) })],
            "POST /organizations/org/previews/:id/deployments": [yes({ id: ID(4) })],
        });
        const steps: string[] = [];
        await runDeploy({
            call,
            organizationId: "org",
            file,
            spa: false,
            resume: newResume(),
            previewId: ID(2),
            onStep: (s) => steps.push(s),
        });
        expect(steps).toEqual(["upload", "deploy"]);
        expect(sent.map((s) => s.path)).toEqual([
            "/organizations/org/artifacts",
            `/organizations/org/previews/${ID(2)}/deployments`,
        ]);
        const fresh = fake({
            "POST /organizations/org/projects/:id/previews": [yes({ id: ID(2) })],
            "POST /organizations/org/artifacts": [yes({ id: ID(3) })],
            "POST /organizations/org/previews/:id/deployments": [yes({ id: ID(4) })],
        });
        await runDeploy({
            call: fresh.call,
            organizationId: "org",
            file,
            spa: false,
            resume: newResume(),
            create: { projectId: ID(1), slug: "site" },
        });
        expect(fresh.sent[0]!.json).toEqual({ slug: "site" });
    });

    it("stops at the step that failed and resumes from it, without making anything twice", async () => {
        const { sent, call } = fake({
            "POST /organizations/org/projects/:id/previews": [yes({ id: ID(2) })],
            "POST /organizations/org/artifacts": [
                no("The upload is larger than the allowed size.", 413),
                yes({ id: ID(3) }),
            ],
            "POST /organizations/org/previews/:id/deployments": [
                no("A deployment is already running."),
                yes({ id: ID(4) }),
            ],
        });
        const resume = newResume();
        const input = {
            call,
            organizationId: "org",
            file,
            spa: false,
            resume,
            create: { projectId: ID(1), slug: "site" },
        };
        expect(await runDeploy(input)).toEqual({
            ok: false,
            step: "upload",
            status: 413,
            message: "The upload is larger than the allowed size.",
        });
        expect(resume.previewId).toBe(ID(2));
        expect(await runDeploy(input)).toMatchObject({
            ok: false,
            step: "deploy",
            message: "A deployment is already running.",
        });
        expect(resume.artifactId).toBe(ID(3));
        const keyBefore = resume.deployKey;
        expect(await runDeploy(input)).toEqual({ ok: true, previewId: ID(2), deploymentId: ID(4) });
        // The preview was made once, the archive stored once, and the deploy repeated with its key.
        expect(sent.filter((s) => s.path.endsWith("/previews"))).toHaveLength(1);
        expect(sent.filter((s) => s.path.endsWith("/artifacts"))).toHaveLength(2);
        const deploys = sent.filter((s) => s.path.endsWith("/deployments"));
        expect(deploys).toHaveLength(2);
        expect(new Set(deploys.map((d) => d.key))).toEqual(new Set([keyBefore]));
    });

    it("does not upload for a created preview that turns out to be going away", async () => {
        const { sent, call } = fake({
            "POST /organizations/org/projects/:id/previews": [
                yes({ id: ID(2), state: "deleting" }),
            ],
        });
        const resume = newResume();
        const result = await runDeploy({
            call,
            organizationId: "org",
            file,
            spa: false,
            resume,
            create: { projectId: ID(1), slug: "site" },
        });
        expect(result).toMatchObject({ ok: false, step: "create", status: 409 });
        expect(sent).toHaveLength(1);
        expect(resume.previewId).toBeUndefined();
    });

    it("reports a failed creation as such, and never uploads", async () => {
        const { sent, call } = fake({
            "POST /organizations/org/projects/:id/previews": [no("That preview name is taken.")],
        });
        const result = await runDeploy({
            call,
            organizationId: "org",
            file,
            spa: false,
            resume: newResume(),
            create: { projectId: ID(1), slug: "site" },
        });
        expect(result).toEqual({
            ok: false,
            step: "create",
            status: 409,
            message: "That preview name is taken.",
        });
        expect(sent).toHaveLength(1);
        const none = await runDeploy({
            call,
            organizationId: "org",
            file,
            spa: false,
            resume: newResume(),
        });
        expect(none).toMatchObject({ ok: false, step: "create" });
    });
});

describe("keys that cannot be reused wrongly", () => {
    it("makes its keys without randomUUID, which plain-HTTP pages do not have", () => {
        const real = globalThis.crypto;
        Object.defineProperty(globalThis, "crypto", {
            value: { getRandomValues: real.getRandomValues.bind(real) },
            configurable: true,
        });
        try {
            const a = newResume();
            const b = newResume();
            expect(a.createKey).toMatch(/^dashboard-preview-[0-9a-f]{32}$/);
            expect(a.deployKey).toMatch(/^dashboard-deploy-[0-9a-f]{32}$/);
            expect(a.createKey).not.toBe(b.createKey);
        } finally {
            Object.defineProperty(globalThis, "crypto", { value: real, configurable: true });
        }
    });

    it("a new file or a changed setting makes a new deployment key, and a new file a new upload", () => {
        const resume = newResume();
        resume.artifactId = ID(3);
        const before = resume.deployKey;
        withNewSpa(resume);
        expect(resume.deployKey).not.toBe(before);
        expect(resume.artifactId).toBe(ID(3));
        const second = resume.deployKey;
        withNewFile(resume);
        expect(resume.deployKey).not.toBe(second);
        expect(resume.artifactId).toBeUndefined();
    });

    it("keeps the creation key and the fields when a creation may have gone through", () => {
        for (const status of [null, 502, 504, 200]) {
            const resume = newResume();
            const key = resume.createKey;
            afterFailure(resume, { step: "create", status, message: "x" });
            expect(resume.createKey).toBe(key);
            expect(fieldsLocked(resume)).toBe(true);
        }
    });

    it("starts a new creation after a definite refusal, which recorded nothing", () => {
        for (const status of [409, 422, 403]) {
            const resume = newResume();
            const key = resume.createKey;
            afterFailure(resume, { step: "create", status, message: "That name is taken." });
            expect(resume.createKey).not.toBe(key);
            expect(fieldsLocked(resume)).toBe(false);
        }
    });

    it("keeps an earlier uncertain creation in doubt through a later refusal, such as a lapsed sign-in", () => {
        const resume = newResume();
        const key = resume.createKey;
        afterFailure(resume, { step: "create", status: null, message: "x" });
        afterFailure(resume, { step: "create", status: 401, message: "Unauthorized" });
        expect(resume.createKey).toBe(key);
        expect(fieldsLocked(resume)).toBe(true);
        afterFailure(resume, { step: "create", status: 409, message: "Taken" });
        expect(resume.createKey).toBe(key);
        expect(resume.createUncertain).toBe(true);
    });

    it("forgets what no longer exists after a 404 on deploying", () => {
        const resume = newResume();
        resume.previewId = ID(2);
        resume.artifactId = ID(3);
        const key = resume.createKey;
        const before = resume.deployKey;
        afterFailure(resume, { step: "deploy", status: 404, message: "Artifact not found." });
        expect(resume.deployKey).toBe(before);
        expect(resume.artifactId).toBeUndefined();
        expect(resume.previewId).toBe(ID(2));
        resume.artifactId = ID(3);
        afterFailure(resume, { step: "deploy", status: 404, message: "Preview not found." });
        expect(resume.previewId).toBeUndefined();
        expect(resume.createKey).not.toBe(key);
        expect(resume.deployKey).not.toBe(before);
        // Other failures change nothing.
        resume.previewId = ID(2);
        const keep = { ...resume };
        afterFailure(resume, { step: "deploy", status: 409, message: "A deployment is running." });
        expect(resume).toEqual(keep);
    });

    it("states a limit below a mebibyte in kibibytes", () => {
        expect(
            checkDeployForm({
                needsName: false,
                name: "",
                file: { name: "a.tgz", size: 600_000 },
                maxBytes: 512 * 1024,
            })[0],
        ).toContain("512 KiB");
    });
});
