import type { ApiResult } from "./api";

const SLUG = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
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
    if (input.needsName && !SLUG.test(input.name)) {
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
        problems.push(
            `That file is larger than the ${Math.floor(input.maxBytes / (1024 * 1024))} MiB this server accepts.`,
        );
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
}

export const newResume = (): Resume => ({
    createKey: `dashboard-preview-${crypto.randomUUID()}`,
    deployKey: `dashboard-deploy-${crypto.randomUUID()}`,
});

export type FlowResult =
    | { ok: true; previewId: string; deploymentId: string }
    | { ok: false; message: string; step: "create" | "upload" | "deploy" };

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
            return { ok: false, step: "create", message: "No preview to deploy to." };
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
        if (!created.ok) return { ok: false, step: "create", message: created.message };
        resume.previewId = created.data.id;
    }
    if (!resume.artifactId) {
        input.onStep?.("upload");
        const stored = await call<{ id: string }>("POST", `/organizations/${org}/artifacts`, {
            raw: { body: input.file, contentType: "application/gzip" },
        });
        if (!stored.ok) return { ok: false, step: "upload", message: stored.message };
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
    if (!queued.ok) return { ok: false, step: "deploy", message: queued.message };
    return { ok: true, previewId: resume.previewId, deploymentId: queued.data.id };
}
