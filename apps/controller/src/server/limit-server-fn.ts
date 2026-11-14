import { MAX_BODY_BYTES } from "./limits";
import { framingProblem, framingResponse } from "./body-framing";

// TanStack Start server functions (`/_serverFn/**`) carry small JSON arguments. They
// do not pass through the API adapter, so without this a client could stream a huge
// body into one. Registered as a Nitro middleware in vite.config.ts.
export default function limitServerFunctionBodies(event: { req: Request }) {
    const problem = framingProblem(event.req, MAX_BODY_BYTES);
    return problem ? framingResponse(problem) : undefined;
}
