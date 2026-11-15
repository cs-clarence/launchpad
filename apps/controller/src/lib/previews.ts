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
