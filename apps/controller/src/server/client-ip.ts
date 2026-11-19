import { CLIENT_IP_HEADER } from "@launchpad-kit/auth";

// Determines the client address Launchpad trusts. Any client-supplied value of
// our own header is discarded. Behind exactly one trusted proxy, the address
// that proxy appended (the rightmost X-Forwarded-For entry) is used; otherwise
// the TCP peer address. Returns null when no address can be determined.
export function resolveClientIp(options: {
    forwardedFor: string | null;
    socketIp: string | null;
    trustedProxy: boolean;
}): string | null {
    if (options.trustedProxy && options.forwardedFor) {
        const last = options.forwardedFor.split(",").at(-1)?.trim();
        if (last) {
            return last;
        }
    }
    return options.socketIp || null;
}

// A trusted copy of the request: spoofable headers are replaced, never merged.
export function withClientIp(request: Request, clientIp: string): Request {
    const headers = new Headers(request.headers);
    headers.delete(CLIENT_IP_HEADER);
    headers.set(CLIENT_IP_HEADER, clientIp);
    return new Request(request, { headers });
}
