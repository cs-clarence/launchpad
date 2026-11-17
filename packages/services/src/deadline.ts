// A deadline for work done under a lease, measured two ways: a monotonic timer (immune to
// the clock being corrected) and the wall clock. A machine that is suspended stops the
// first but not the second, so a worker that wakes up long after its lease ran out sees it
// has, and starts nothing more.
export interface Deadline {
    // Whether the time is up by either clock.
    passed(): boolean;
    // Milliseconds left by the monotonic timer, for aborting calls under way.
    remainingMs(): number;
}

export function startDeadline(ms: number): Deadline {
    const monotonic = performance.now() + ms;
    const wall = Date.now() + ms;
    return {
        passed: () => performance.now() >= monotonic || Date.now() >= wall,
        remainingMs: () => Math.max(1, Math.floor(monotonic - performance.now())),
    };
}
