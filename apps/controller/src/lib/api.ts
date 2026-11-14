// Same-origin JSON calls to the Launchpad API; the browser sends the session
// cookie and an Origin header that the server checks.
export async function apiRequest(
    method: "POST" | "DELETE",
    path: string,
    body?: unknown,
): Promise<{ ok: true } | { ok: false; message: string }> {
    let response: Response;
    try {
        response = await fetch(`/api/v1${path}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
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
