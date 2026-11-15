import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import {
    LaunchpadApiError,
    LaunchpadTransportError,
    type Deployment,
    type Preview,
} from "@launchpad/sdk";
import { ClientCoreError } from "./errors";
import { clientFor, type Context, resolve } from "./operations";
import { packDirectory, readArchive } from "./pack";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "reconciliation-needed"]);
const SLUG = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

export type DeployOutcome =
    | "succeeded"
    | "failed"
    | "cancelled"
    | "reconciliation-needed"
    // Queued (and --no-wait), or still running when the wait ran out.
    | "queued"
    | "timeout";

export type Progress =
    | { kind: "step"; message: string }
    | { kind: "event"; seq: number; phase: string; level: string; message: string }
    | { kind: "status"; status: string };

export interface DeployInput {
    // A built directory (packed here) or an existing `.tar.gz`.
    source: string;
    // The project's slug or id, and the preview's name (its slug).
    project: string;
    name: string;
    spa?: boolean;
    wait?: boolean;
    waitTimeoutMs?: number;
    pollMs?: number;
    profile?: string;
    onProgress?: (progress: Progress) => void;
    signal?: AbortSignal;
    // Replaceable so tests need not wait.
    sleep?: (ms: number) => Promise<void>;
}

export interface DeployResult {
    outcome: DeployOutcome;
    preview: Pick<Preview, "id" | "slug" | "hostname">;
    artifact: { id: string; reused: boolean; sizeBytes: number };
    deployment: Deployment | { id: string; status: string };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Only a failure to get an answer is worth repeating, and only because every repeated
// request carries the same idempotency key: the controller then returns the first result.
async function retrying<T>(
    run: () => Promise<T>,
    sleep: (ms: number) => Promise<void>,
): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await run();
        } catch (error) {
            const retryable =
                error instanceof LaunchpadTransportError &&
                (error.reason === "unreachable" || error.reason === "timeout");
            if (!retryable || attempt >= 3) throw error;
            await sleep(500 * attempt);
        }
    }
}

// Packs and uploads a site, finds or creates the preview, queues the deployment and,
// unless told not to, follows it to the end. Everything is done through the controller.
export async function deploy(ctx: Context, input: DeployInput): Promise<DeployResult> {
    if (!SLUG.test(input.name)) {
        throw new ClientCoreError(
            "bad-input",
            "A preview name is lowercase letters, digits and hyphens (40 characters at most).",
        );
    }
    const sleep = input.sleep ?? defaultSleep;
    const progress = input.onProgress ?? (() => {});
    const resolved = await resolve(ctx, input.profile);
    const client = clientFor(ctx, resolved);
    const organizationId = resolved.organizationId ?? (await client.key.get()).organizationId;

    const projects = await client.projects.list(organizationId);
    const project = projects.find((p) => p.id === input.project || p.slug === input.project);
    if (!project) {
        throw new ClientCoreError("bad-input", `This key cannot see a project "${input.project}".`);
    }

    const stat = await fs.lstat(input.source).catch(() => undefined);
    if (!stat) throw new ClientCoreError("bad-input", "The source does not exist.");
    progress({ kind: "step", message: "Packing the site" });
    const packed = stat.isDirectory()
        ? await packDirectory(input.source)
        : await readArchive(input.source);

    progress({ kind: "step", message: `Uploading ${packed.archive.length} bytes` });
    const artifact = await client.artifacts.upload(organizationId, packed.archive, {
        signal: input.signal,
    });
    progress({
        kind: "step",
        message: artifact.reused ? "Archive already stored" : "Archive stored",
    });

    const preview = await findOrCreatePreview(
        client,
        organizationId,
        project.id,
        input.name,
        sleep,
    );
    progress({ kind: "step", message: `Deploying to ${preview.hostname}` });

    const idempotencyKey = `deploy-${randomUUID()}`;
    const queued = await retrying(
        () =>
            client.deployments.create(
                organizationId,
                preview.id,
                { artifactId: artifact.id, spa: input.spa ?? false },
                { idempotencyKey },
            ),
        sleep,
    );
    const base = {
        preview: { id: preview.id, slug: preview.slug, hostname: preview.hostname },
        artifact: { id: artifact.id, reused: artifact.reused, sizeBytes: artifact.sizeBytes },
    };
    if (input.wait === false) {
        return { ...base, outcome: "queued", deployment: { id: queued.id, status: queued.status } };
    }

    const deadline = Date.now() + (input.waitTimeoutMs ?? 15 * 60_000);
    const pollMs = input.pollMs ?? 2000;
    let after = 0;
    let lastStatus = "";
    let misses = 0;
    for (;;) {
        try {
            const events = await client.deployments.events(organizationId, queued.id, after, {
                signal: input.signal,
            });
            for (const event of events.items) {
                progress({ kind: "event", ...event });
                after = event.seq;
            }
            const current = await client.deployments.get(organizationId, queued.id, {
                signal: input.signal,
            });
            misses = 0;
            if (current.status !== lastStatus) {
                lastStatus = current.status;
                progress({ kind: "status", status: current.status });
            }
            if (TERMINAL.has(current.status)) {
                return { ...base, outcome: current.status as DeployOutcome, deployment: current };
            }
        } catch (error) {
            // A dropped poll is not a failed deployment; give up only when it persists.
            const transient =
                error instanceof LaunchpadTransportError &&
                (error.reason === "unreachable" || error.reason === "timeout");
            if (!transient || ++misses >= 5) throw error;
        }
        if (Date.now() + pollMs > deadline) {
            return {
                ...base,
                outcome: "timeout",
                deployment: { id: queued.id, status: lastStatus || queued.status },
            };
        }
        await sleep(pollMs);
    }
}

async function findOrCreatePreview(
    client: ReturnType<typeof clientFor>,
    organizationId: string,
    projectId: string,
    slug: string,
    sleep: (ms: number) => Promise<void>,
): Promise<Preview> {
    const find = async (): Promise<Preview | undefined> => {
        let cursor: string | undefined;
        // Bounded, so a preview-heavy project cannot make this run on.
        for (let page = 0; page < 20; page++) {
            const result = await client.previews.list(organizationId, { projectId, cursor });
            const found = result.items.find((p) => p.slug === slug);
            if (found) return found;
            if (!result.nextCursor) return undefined;
            cursor = result.nextCursor;
        }
        return undefined;
    };
    const existing = await find();
    if (existing) return existing;
    try {
        return await retrying(
            () =>
                client.previews.create(
                    organizationId,
                    projectId,
                    { slug },
                    { idempotencyKey: `preview-${randomUUID()}` },
                ),
            sleep,
        );
    } catch (error) {
        // Created by someone else between the list and the create: use theirs.
        if (error instanceof LaunchpadApiError && error.status === 409) {
            const raced = await find();
            if (raced) return raced;
        }
        throw error;
    }
}
