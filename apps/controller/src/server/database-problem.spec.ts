import { SchemaMismatchError } from "@launchpad-kit/database";
import { describe, expect, it } from "vitest";
import { ServiceError } from "@launchpad-kit/services";
import { describeProblem, PROBLEM_MESSAGES } from "../lib/problem";
import {
    databaseProblem,
    problemBody,
    problemOfFailure,
    withDatabaseProblems,
} from "./database-problem";
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

describe("withDatabaseProblems", () => {
    const run = (error: unknown) =>
        withDatabaseProblems(async () => {
            throw error;
        });

    it("turns database problems into the fixed codes the page reads, without the error text", async () => {
        const refused = Object.assign(new Error("Failed to connect to 10.0.0.5:5432"), {
            code: "ERR_POSTGRES_CONNECTION_REFUSED",
        });
        const caught = await run(refused).catch((error) => error as Error);
        expect(caught.message).toBe(PROBLEM_MESSAGES["database-unavailable"]);
        expect(describeProblem(caught)?.code).toBe("database-unavailable");
        expect(caught.message).not.toContain("10.0.0.5");
        const mismatch = await run(new SchemaMismatchError("password=x")).catch((e) => e as Error);
        expect(describeProblem(mismatch)?.code).toBe("schema-mismatch");
        const rejected = await run(
            new GateRejectedError({ kind: "unavailable", error: new Error("/srv/private") }),
        ).catch((e) => e as Error);
        expect(describeProblem(rejected)?.code).toBe("unavailable");
    });

    it("maps a missing or forbidden organization to not-found, and leaves everything else alone", async () => {
        for (const code of ["not-found", "forbidden"] as const) {
            const caught = await run(new ServiceError(code, "Some detail")).catch(
                (e) => e as Error,
            );
            expect(describeProblem(caught)?.code).toBe("not-found");
        }
        const invalid = new ServiceError("invalid", "Bad input");
        await expect(run(invalid)).rejects.toBe(invalid);
        const boom = new Error("boom");
        await expect(run(boom)).rejects.toBe(boom);
        await expect(withDatabaseProblems(async () => 42)).resolves.toBe(42);
    });
});
