import { useEffect, useState } from "react";

// A clock that starts at the server's time and moves on by what a monotonic timer has
// advanced, so neither a wrong browser clock nor a correction of it while the page is open
// shows. `monotonic` is replaceable for tests.
export function createClock(
    serverNow: number,
    monotonic: () => number = () => performance.now(),
): () => number {
    const start = monotonic();
    return () => serverNow + (monotonic() - start);
}

// The first render uses exactly the server's time (so the page the server sent and the one
// the browser builds agree), then the time moves on, so "expires in 1 minute" does not stay
// on screen after it has passed. A fresh load from the server starts it again.
export function useNow(serverNow: number, everyMs = 30_000): number {
    const [now, setNow] = useState(serverNow);
    useEffect(() => {
        const clock = createClock(serverNow);
        setNow(serverNow);
        const timer = setInterval(() => setNow(clock()), everyMs);
        return () => clearInterval(timer);
    }, [serverNow, everyMs]);
    return now;
}
