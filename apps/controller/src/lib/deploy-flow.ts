import { slugSchema } from "@launchpad/contracts";
import type { ApiResult } from "./api";

const ARCHIVE = /\.(tar\.gz|tgz)$/i;

// What the browser can tell before sending anything. These are conveniences: the server
// checks the same things (and more) and is the rule.
export function checkDeployForm(input: {
    needsName: boolean;
    name: string;
    file: { name: string; size: number } | null;
    maxBytes: number;
}): string[] {
    const problems: string[] = [];
    if (input.needsName && !slugSchema.safeParse(input.name).success) {
        problems.push(
            "The name uses lowercase letters, digits and hyphens (40 characters at most).",
        );
    }
    if (!input.file) {
        problems.push("Choose the built site as a .tar.gz file.");
    } else if (!ARCHIVE.test(input.file.name)) {
        problems.push("The site must be a .tar.gz (or .tgz) archive of the built directory.");
    } else if (input.file.size === 0) {
        problems.push("That file is empty.");
    } else if (input.file.size > input.maxBytes) {
        const limit =
            input.maxBytes >= 1024 * 1024
                ? `${Math.floor(input.maxBytes / (1024 * 1024))} MiB`
                : `${Math.max(1, Math.floor(input.maxBytes / 1024))} KiB`;
        problems.push(`That file is larger than the ${limit} this server accepts.`);
    }
    return problems;
}

export type Call = <T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options?: {
        json?: unknown;
        raw?: { body: Blob; contentType: string };
        headers?: Record<string, string>;
    },
) => Promise<ApiResult<T>>;

// What a failed run has already done, so that trying again does not do it twice: the same
// keys (a lost answer then gets the first result back), the preview that was created and the
// archive that was stored.
export interface Resume {
    createKey: string;
    deployKey: string;
    previewId?: string;
    artifactId?: string;
    // A creation that may have gone through without an answer reaching us: its fields must
    // not change, or the same key would be sent with a different request.
    createUncertain?: boolean;
}

// Random from getRandomValues, which a browser gives to plain-HTTP pages too (randomUUID is
// only for secure contexts).
export function randomId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const newResume = (): Resume => ({
    createKey: `dashboard-preview-${randomId()}`,
    deployKey: `dashboard-deploy-${randomId()}`,
});

// A different file is a different upload and a different deployment.
export function withNewFile(resume: Resume): void {
    resume.artifactId = undefined;
    resume.deployKey = `dashboard-deploy-${randomId()}`;
}

// The single-page setting is part of what a deployment key stands for.
export function withNewSpa(resume: Resume): void {
    resume.deployKey = `dashboard-deploy-${randomId()}`;
}

// Whether the fields that made the preview may still be changed.
export const fieldsLocked = (resume: Resume): boolean =>
    resume.previewId !== undefined || resume.createUncertain === true;

// What to forget after a failure, so the next try neither repeats what is done nor sticks to
// something that no longer exists.
export function afterFailure(
    resume: Resume,
    failure: { step: "create" | "upload" | "deploy"; status: number | null; message: string },
): void {
    if (failure.step === "create") {
        // An answer that never came (or a server error) may hide a creation that happened: keep
        // the key and the fields. A definite refusal recorded nothing: the next try is new.
        // A 2xx whose answer could not be read is a creation that happened.
        const unknown = failure.status === null || failure.status >= 500 || failure.status < 300;
        // An earlier attempt that may have gone through stays in doubt (and keeps its key)
        // until a creation succeeds or the user starts over: a later refusal, a sign-in
        // that has lapsed for one, says nothing about it.
        if (unknown) resume.createUncertain = true;
        else if (!resume.createUncertain) resume.createKey = `dashboard-preview-${randomId()}`;
    }
    if (failure.step === "deploy" && failure.status === 404) {
        // The archive was collected, or the preview deleted, since the last try.
        resume.artifactId = undefined;
        if (/preview/i.test(failure.message)) {
            resume.previewId = undefined;
            // The earlier deployment request, if it went through unseen, was for that preview.
            resume.deployKey = `dashboard-deploy-${randomId()}`;
            resume.createKey = `dashboard-preview-${randomId()}`;
            resume.createUncertain = false;
        }
    }
}

export type FlowResult =
    | { ok: true; previewId: string; deploymentId: string }
    | {
          ok: false;
          message: string;
          step: "create" | "upload" | "deploy";
          status: number | null;
      };

// Creates the preview (unless one is given), uploads the archive and queues the deployment,
// the three calls the CLI makes, and reports which step it is on. It updates `resume` as it
// goes, so calling it again with the same object picks up at the step that failed.
export async function runDeploy(input: {
    call: Call;
    organizationId: string;
    file: Blob;
    spa: boolean;
    resume: Resume;
    // A new preview: where and what to call it, and for how long.
    create?: { projectId: string; slug: string; ttl?: string };
    // An existing preview to deploy to.
    previewId?: string;
    onStep?: (step: "create" | "upload" | "deploy") => void;
}): Promise<FlowResult> {
    const { call, organizationId: org, resume } = input;
    if (input.previewId) resume.previewId ??= input.previewId;
    if (!resume.previewId) {
        if (!input.create) {
            return { ok: false, step: "create", status: null, message: "No preview to deploy to." };
        }
        input.onStep?.("create");
        const created = await call<{ id: string }>(
            "POST",
            `/organizations/${org}/projects/${input.create.projectId}/previews`,
            {
                json: {
                    slug: input.create.slug,
                    ...(input.create.ttl ? { ttl: input.create.ttl } : {}),
                },
                headers: { "idempotency-key": resume.createKey },
            },
        );
        if (!created.ok) {
            return { ok: false, step: "create", status: created.status, message: created.message };
        }
        resume.previewId = created.data.id;
    }
    if (!resume.artifactId) {
        input.onStep?.("upload");
        const stored = await call<{ id: string }>("POST", `/organizations/${org}/artifacts`, {
            raw: { body: input.file, contentType: "application/gzip" },
        });
        if (!stored.ok) {
            return { ok: false, step: "upload", status: stored.status, message: stored.message };
        }
        resume.artifactId = stored.data.id;
    }
    input.onStep?.("deploy");
    const queued = await call<{ id: string }>(
        "POST",
        `/organizations/${org}/previews/${resume.previewId}/deployments`,
        {
            json: { artifactId: resume.artifactId, spa: input.spa },
            headers: { "idempotency-key": resume.deployKey },
        },
    );
    if (!queued.ok) {
        return { ok: false, step: "deploy", status: queued.status, message: queued.message };
    }
    return { ok: true, previewId: resume.previewId, deploymentId: queued.data.id };
}
