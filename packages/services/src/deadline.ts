// A deadline for work done under a lease, measured two ways: a monotonic timer (immune to
// the clock being corrected) and the wall clock. A machine that is suspended stops the
// first but not the second, so a worker that wakes up long after its lease ran out sees it
// has, and starts nothing more.
export interface Deadline {
    // Whether the time is up by either clock.
    passed(): boolean;
    // Milliseconds left by the monotonic timer.
    remainingMs(): number;
    // A signal that aborts when the time is up by either clock, for calls under way. The wall
    // clock is looked at every second (and a timer that was frozen by a suspend fires as soon as
    // the machine wakes), so steps that follow one another under one signal, as a rollback's
    // do, stop after a suspend instead of carrying on with a lease that has run out.
    signal(): AbortSignal;
    // Stops watching, for every signal given out. Called when the work under the lease is done,
    // so nothing keeps looking at the clock until the lease would have run out.
    stop(): void;
}

const WALL_POLL_MS = 1000;

export function startDeadline(ms: number): Deadline {
    const monotonic = performance.now() + ms;
    const wall = Date.now() + ms;
    const passedNow = () => performance.now() >= monotonic || Date.now() >= wall;
    const watchers = new Set<() => void>();
    return {
        passed: passedNow,
        remainingMs: () => Math.max(1, Math.floor(monotonic - performance.now())),
        signal: () => {
            const controller = new AbortController();
            const stop = () => {
                clearTimeout(timer);
                clearInterval(poll);
                watchers.delete(stop);
            };
            watchers.add(stop);
            const expire = () => {
                stop();
                controller.abort(new DOMException("The lease deadline passed.", "TimeoutError"));
            };
            const timer = setTimeout(
                expire,
                Math.max(1, Math.floor(monotonic - performance.now())),
            );
            const poll = setInterval(() => {
                if (passedNow()) expire();
            }, WALL_POLL_MS);
            // Neither keeps a process alive: the work they watch does.
            timer.unref?.();
            poll.unref?.();
            return controller.signal;
        },
        stop: () => {
            for (const stop of [...watchers]) stop();
        },
    };
}
