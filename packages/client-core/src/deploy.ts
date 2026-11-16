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
import { type FileSelection, packDirectory, readArchive } from "./pack";
import { resolveProjectId } from "./project";

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
    | { kind: "status"; status: string }
    // Sent as soon as the deployment is accepted, so a caller that stops waiting still has
    // the id to follow it with.
    | { kind: "queued"; deploymentId: string };

export interface DeployInput {
    // A built directory (packed here) or an existing `.tar.gz`.
    source: string;
    // The project's slug or id, and the preview's name (its slug).
    project: string;
    name: string;
    spa?: boolean;
    // Limits which files of a directory are published (never applies to an archive).
    selection?: FileSelection;
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
    signal?: AbortSignal,
): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        // A cancelled deployment does no further work, not even another attempt.
        signal?.throwIfAborted();
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

    const projectId = await resolveProjectId(client, organizationId, input.project);

    const stat = await fs.lstat(input.source).catch(() => undefined);
    if (!stat) throw new ClientCoreError("bad-input", "The source does not exist.");
    progress({ kind: "step", message: "Packing the site" });
    // A selection only describes a directory. If the source stopped being one since it was
    // checked, an archive must not be sent in its place and skip the operator's patterns.
    if (input.selection && !stat.isDirectory()) {
        throw new ClientCoreError(
            "bad-input",
            "The source changed; a selected deploy needs a directory.",
        );
    }
    const packed = stat.isDirectory()
        ? await packDirectory(input.source, undefined, input.selection, input.signal)
        : await readArchive(input.source);

    // The preview is settled before the upload: a stored archive is kept for good, so
    // one is not spent on a deploy that cannot start.
    input.signal?.throwIfAborted();
    const preview = await findOrCreatePreview(
        client,
        organizationId,
        projectId,
        input.name,
        sleep,
        input.signal,
    );
    progress({ kind: "step", message: `Uploading ${packed.archive.length} bytes` });
    const artifact = await client.artifacts.upload(organizationId, packed.archive, {
        signal: input.signal,
    });
    progress({
        kind: "step",
        message: artifact.reused ? "Archive already stored" : "Archive stored",
    });

    input.signal?.throwIfAborted();
    progress({ kind: "step", message: `Deploying to ${preview.hostname}` });

    const idempotencyKey = `deploy-${randomUUID()}`;
    const queued = await retrying(
        () =>
            client.deployments.create(
                organizationId,
                preview.id,
                { artifactId: artifact.id, spa: input.spa ?? false },
                { idempotencyKey, signal: input.signal },
            ),
        sleep,
        input.signal,
    );
    progress({ kind: "queued", deploymentId: queued.id });
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
    const timedOut = (): DeployResult => ({
        ...base,
        outcome: "timeout",
        deployment: { id: queued.id, status: lastStatus || queued.status },
    });
    // Every request is held to what is left of the wait, so a one-second wait cannot
    // take half a minute; the caller's own cancellation is kept apart from the deadline.
    const budget = () =>
        AbortSignal.any([
            ...(input.signal ? [input.signal] : []),
            AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        ]);
    // Pages through every event after the last one delivered, so nothing is lost to a
    // page boundary or to events that arrive between this and the status request.
    const drainEvents = async () => {
        for (let page = 0; page < 50; page++) {
            const events = await client.deployments.events(organizationId, queued.id, after, {
                signal: budget(),
            });
            for (const event of events.items) {
                progress({ kind: "event", ...event });
                after = event.seq;
            }
            if (events.nextAfter === null || events.items.length === 0) return;
        }
    };
    for (;;) {
        input.signal?.throwIfAborted();
        try {
            await drainEvents();
            const current = await client.deployments.get(organizationId, queued.id, {
                signal: budget(),
            });
            misses = 0;
            if (current.status !== lastStatus) {
                lastStatus = current.status;
                progress({ kind: "status", status: current.status });
            }
            if (TERMINAL.has(current.status)) {
                // Whatever was written between the events request and the status.
                await drainEvents().catch(() => {});
                // Cancelled while the last events were delivered: that is the caller's call.
                input.signal?.throwIfAborted();
                return { ...base, outcome: current.status as DeployOutcome, deployment: current };
            }
        } catch (error) {
            if (input.signal?.aborted) throw error;
            if (Date.now() >= deadline) return timedOut();
            // A dropped poll is not a failed deployment; give up only when it persists.
            const transient =
                error instanceof LaunchpadTransportError &&
                (error.reason === "unreachable" || error.reason === "timeout");
            if (!transient || ++misses >= 5) throw error;
        }
        if (Date.now() + pollMs > deadline) return timedOut();
        await sleep(pollMs);
    }
}

async function findOrCreatePreview(
    client: ReturnType<typeof clientFor>,
    organizationId: string,
    projectId: string,
    slug: string,
    sleep: (ms: number) => Promise<void>,
    signal?: AbortSignal,
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
    // A preview of that name that is expiring or being deleted cannot take a deployment,
    // and its name is free again only once it is gone.
    const usable = (found: Preview): Preview => {
        if (found.state !== "active") {
            throw new ClientCoreError(
                "bad-input",
                `The preview "${slug}" is being deleted. Try again in a few minutes, when its name is free.`,
            );
        }
        return found;
    };
    const existing = await find();
    if (existing) return usable(existing);
    signal?.throwIfAborted();
    // One key for every attempt: if a create committed but its answer was lost, the
    // retry gets that same preview back instead of a conflict.
    const idempotencyKey = `preview-${randomUUID()}`;
    try {
        return await retrying(
            () =>
                client.previews.create(
                    organizationId,
                    projectId,
                    { slug },
                    { idempotencyKey, signal },
                ),
            sleep,
            signal,
        );
    } catch (error) {
        // Created by someone else between the list and the create: use theirs.
        if (error instanceof LaunchpadApiError && error.status === 409) {
            const raced = await find();
            if (raced) return usable(raced);
        }
        throw error;
    }
}
