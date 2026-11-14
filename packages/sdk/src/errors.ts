// Errors never carry the API key, the request headers or the response body.

// The controller answered with an error status.
export class LaunchpadApiError extends Error {
    readonly status: number;
    // A stable machine code (`not-found`, `forbidden`, ...). Servers may add codes, so
    // treat unknown values as a generic failure of that status.
    readonly code: string;
    readonly title: string;
    readonly retryAfterSeconds: number | null;

    constructor(init: { status: number; code: string; title: string; retryAfterSeconds?: number }) {
        super(init.title);
        this.name = "LaunchpadApiError";
        this.status = init.status;
        this.code = init.code;
        this.title = init.title;
        this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    }
}

// No usable answer: the controller was unreachable, timed out, redirected, or answered
// with something that is not this API.
export class LaunchpadTransportError extends Error {
    readonly reason: "unreachable" | "timeout" | "redirect" | "invalid-response";

    constructor(reason: LaunchpadTransportError["reason"], message: string) {
        super(message);
        this.name = "LaunchpadTransportError";
        this.reason = reason;
    }
}

// The client was configured with something unsafe or malformed.
export class LaunchpadConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LaunchpadConfigError";
    }
}
