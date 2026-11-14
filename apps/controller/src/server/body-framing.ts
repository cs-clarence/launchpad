export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// A request body must arrive with a declared length that is within `limit`, so the
// limit can be enforced before anything is read. Returns the refusal, or null.
export function framingProblem(
    request: Request,
    limit: number,
): { status: 411 | 413; title: string } | null {
    if (SAFE_METHODS.has(request.method)) return null;
    const declared = request.headers.get("content-length");
    // Any transfer coding means an undeclared length; the limit cannot be enforced
    // before reading, and legitimate clients send a length.
    const encoded = request.headers.has("transfer-encoding");
    // A body with no declared length (neither header) would reach the readers
    // unbounded, so a body must always arrive with a length.
    const unframed = request.body !== null && declared === null;
    if (encoded || unframed || (declared !== null && !/^\d+$/.test(declared))) {
        return { status: 411, title: "Length Required" };
    }
    if (declared !== null && Number(declared) > limit) {
        return { status: 413, title: "Payload Too Large" };
    }
    return null;
}

export function framingResponse(problem: { status: number; title: string }): Response {
    return Response.json(
        { code: "invalid", status: problem.status, title: problem.title },
        { status: problem.status },
    );
}
