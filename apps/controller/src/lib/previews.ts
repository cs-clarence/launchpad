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
// Whole units are rounded down so the time left is never overstated.
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
    if (ms < 60_000) return "Expires in less than a minute";
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return `Expires in ${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `Expires in ${hours} hour${hours === 1 ? "" : "s"}`;
    return `Expires in ${Math.floor(hours / 24)} days`;
}

const EXTEND_OPTIONS = [
    ["24h", 86_400],
    ["3d", 3 * 86_400],
    ["7d", 7 * 86_400],
    ["14d", 14 * 86_400],
] as const;

// The lifetimes offered for extending: those the server would accept, and the default is the
// longest of them that is at most a week.
export function extendChoices(maxTtlSeconds: number): { choices: string[]; initial: string } {
    const choices: string[] = EXTEND_OPTIONS.filter(([, seconds]) => seconds <= maxTtlSeconds).map(
        ([name]) => name,
    );
    if (choices.length === 0) choices.push(`${Math.max(1, Math.floor(maxTtlSeconds))}s`);
    const week = EXTEND_OPTIONS.filter(([, seconds]) => seconds <= 7 * 86_400)
        .map(([name]) => name)
        .filter((name) => choices.includes(name));
    return { choices, initial: week.at(-1) ?? choices[0]! };
}

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
