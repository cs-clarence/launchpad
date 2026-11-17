// Same-origin JSON calls to the Launchpad API; the browser sends the session
// cookie and an Origin header that the server checks.
export async function apiRequest(
    method: "POST" | "DELETE",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; message: string }> {
    let response: Response;
    try {
        response = await fetch(`/api/v1${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
        });
    } catch {
        // A dropped connection rejects instead of returning a response.
        return {
            ok: false,
            message: "Could not reach the server. Check your connection and retry.",
        };
    }
    if (response.ok) {
        return { ok: true };
    }
    const problem = (await response.json().catch(() => null)) as { title?: string } | null;
    return { ok: false, message: problem?.title ?? "The request failed." };
}

export type ApiResult<T> =
    | { ok: true; data: T }
    | { ok: false; message: string; status: number | null };

// Same-origin calls that return what the API answered: JSON in and out, or a raw body (an
// archive) in. The browser sends the session cookie and the Origin header the server checks.
export async function apiCall<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: {
        json?: unknown;
        raw?: { body: Blob; contentType: string };
        headers?: Record<string, string>;
        signal?: AbortSignal;
    } = {},
): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { ...options.headers };
    let body: BodyInit | undefined;
    if (options.raw) {
        headers["content-type"] = options.raw.contentType;
        body = options.raw.body;
    } else if (options.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(options.json);
    }
    let response: Response;
    try {
        response = await fetch(`/api/v1${path}`, { method, headers, body, signal: options.signal });
    } catch {
        return {
            ok: false,
            status: null,
            message:
                "The request could not be completed. Check your connection (and that the chosen file has not changed on disk), then retry.",
        };
    }
    if (response.ok) {
        try {
            return { ok: true, data: (await response.json()) as T };
        } catch {
            return {
                ok: false,
                status: response.status,
                message: "The server's answer was not understood.",
            };
        }
    }
    const problem = (await response.json().catch(() => null)) as { title?: string } | null;
    return {
        ok: false,
        status: response.status,
        message: problem?.title ?? "The request failed.",
    };
}
