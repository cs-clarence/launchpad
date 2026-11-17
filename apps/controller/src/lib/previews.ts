const ACTIVE = new Set(["queued", "preparing", "building", "deploying", "verifying"]);

export function isInProgress(status: string): boolean {
    return ACTIVE.has(status);
}

const LABELS: Record<string, string> = {
    queued: "Queued",
    preparing: "Preparing",
    building: "Building",
    deploying: "Deploying",
    verifying: "Verifying",
    succeeded: "Live",
    failed: "Failed",
    cancelled: "Cancelled",
    "reconciliation-needed": "Needs an administrator",
};

export function statusLabel(status: string): string {
    return LABELS[status] ?? status;
}

export interface ProgressEvent {
    seq: number;
    phase: string;
    level: string;
    message: string;
    createdAt: string;
}

// Adds the events of one poll, in order and without repeating any already shown; the
// next poll asks for everything after the highest sequence number held.
export function mergeEvents(
    known: ProgressEvent[],
    fresh: ProgressEvent[],
): { events: ProgressEvent[]; after: number } {
    const seen = new Set(known.map((event) => event.seq));
    const events = [...known, ...fresh.filter((event) => !seen.has(event.seq))].sort(
        (a, b) => a.seq - b.seq,
    );
    return { events, after: events.at(-1)?.seq ?? 0 };
}

// How long until a preview goes, for people: "never", "in 3 days", "in 2 hours", "any
// minute now" (overdue, waiting for the worker), or the state of one that is going away.
export function describeExpiry(
    preview: { state: string; expiresAt: string | Date | null },
    now: number,
): string {
    if (preview.state === "deleting") return "Being deleted";
    if (preview.state === "deleted") return "Deleted";
    if (preview.expiresAt === null) return "Never expires";
    const ms = new Date(preview.expiresAt).getTime() - now;
    if (Number.isNaN(ms)) return "Unknown";
    if (ms <= 0) return "Expired, will be deleted shortly";
    const minutes = Math.ceil(ms / 60_000);
    if (minutes < 60) return `Expires in ${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = Math.ceil(minutes / 60);
    if (hours < 48) return `Expires in ${hours} hour${hours === 1 ? "" : "s"}`;
    const days = Math.ceil(hours / 24);
    return `Expires in ${days} days`;
}

export const EXTEND_CHOICES = ["24h", "3d", "7d", "14d"] as const;

const DELETION_LABELS: Record<string, string> = {
    queued: "Waiting to be removed",
    running: "Being removed",
    succeeded: "Removed",
    "reconciliation-needed": "Needs an administrator",
};

export function deletionLabel(status: string): string {
    return DELETION_LABELS[status] ?? status;
}

// A deletion's note is not always a failure: only a held deletion needs a person.
export function deletionNeedsPerson(status: string): boolean {
    return status === "reconciliation-needed";
}

export function isDeletionInProgress(status: string): boolean {
    return status === "queued" || status === "running";
}
