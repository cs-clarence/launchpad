import { useEffect, useState } from "react";

// The server's clock as of `clientNow`, given what the server said when it loaded the page
// and what the browser's clock said at that moment: it keeps the server's time, so a wrong
// browser clock does not show.
export function serverTime(serverNow: number, clientAtLoad: number, clientNow: number): number {
    return serverNow + (clientNow - clientAtLoad);
}

// The first render uses exactly the server's time (so the page the server sent and the one
// the browser builds agree), then the time moves on, so "expires in 1 minute" does not stay
// on screen after it has passed. A fresh load from the server starts it again.
export function useNow(serverNow: number, everyMs = 30_000): number {
    const [now, setNow] = useState(serverNow);
    useEffect(() => {
        const clientAtLoad = Date.now();
        setNow(serverNow);
        const timer = setInterval(
            () => setNow(serverTime(serverNow, clientAtLoad, Date.now())),
            everyMs,
        );
        return () => clearInterval(timer);
    }, [serverNow, everyMs]);
    return now;
}
