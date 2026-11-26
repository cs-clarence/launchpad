import { SchemaMismatchError } from "@launchpad-kit/database";
import { describe, expect, it } from "vitest";
import { databaseProblem, problemBody, problemOfFailure } from "./database-problem";
import { GateRejectedError, SchemaCheckTimeoutError } from "./schema-gate";

const server = (errno: string, message = "relation secret_t does not exist") =>
    Object.assign(new Error(message), { code: "ERR_POSTGRES_SERVER_ERROR", errno });

describe("databaseProblem", () => {
    it("maps the known problems and nothing else", () => {
        expect(databaseProblem(new SchemaMismatchError("behind"))?.code).toBe("schema-mismatch");
        expect(databaseProblem(server("42P01"))?.code).toBe("schema-mismatch");
        expect(databaseProblem(server("57P01"))?.code).toBe("database-unavailable");
        expect(databaseProblem(new SchemaCheckTimeoutError())?.code).toBe("database-unavailable");
        expect(databaseProblem(server("23505"))).toBeNull();
        expect(databaseProblem(new Error("boom"))).toBeNull();
        expect(databaseProblem("x")).toBeNull();
    });

    it("maps a rejected gate by its outcome", () => {
        const error = new Error("mount is /srv/private");
        expect(databaseProblem(new GateRejectedError({ kind: "unavailable", error }))?.code).toBe(
            "unavailable",
        );
        expect(databaseProblem(new GateRejectedError({ kind: "failed", error }))).toBeNull();
    });

    it("never carries the error's text", () => {
        for (const error of [
            new SchemaMismatchError("password=hunter2"),
            server("42P01", "password=hunter2"),
            new GateRejectedError({ kind: "unavailable", error: new Error("password=hunter2") }),
        ]) {
            const problem = databaseProblem(error)!;
            expect(JSON.stringify(problemBody(problem))).not.toContain("hunter2");
            expect(problem.title).not.toContain("hunter2");
        }
    });

    it("reports an unclassified failure only for readiness, as not ready", () => {
        const failure = { kind: "failed", error: new Error("x") } as const;
        expect(problemOfFailure(failure)).toBeNull();
        expect(problemOfFailure(failure, true)).toMatchObject({
            code: "unavailable",
            status: 503,
            title: "The service is not ready.",
        });
    });
});
