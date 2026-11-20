export class DeadlineExceeded extends Error {}

// A timed-out operation may still be in flight. The runtime owns its resources
// and must close them rather than reusing them after a deadline.
export async function withinDeadline<T>(
    run: () => Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<T> {
    signal?.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceeded()), timeoutMs);
        abort = () => reject(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
    });
    try {
        return await Promise.race([deadline, run()]);
    } finally {
        clearTimeout(timer);
        if (abort) signal?.removeEventListener("abort", abort);
    }
}
