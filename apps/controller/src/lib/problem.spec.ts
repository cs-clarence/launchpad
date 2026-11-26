import { describe, expect, it } from "vitest";
import { describeProblem, messageForProblem, PROBLEM_MESSAGES } from "./problem";

describe("describeProblem", () => {
    it.each(Object.entries(PROBLEM_MESSAGES))("recognises %s from its message", (code, message) => {
        const view = describeProblem(new Error(message));
        expect(view?.code).toBe(code);
        expect(view?.title).toBeTruthy();
        expect(view?.text).toBeTruthy();
    });

    it("says the right thing for each database problem", () => {
        expect(describeProblem(new Error(PROBLEM_MESSAGES["database-unavailable"]))?.text).toBe(
            "Launchpad can't reach its database right now. Try again in a moment.",
        );
        expect(describeProblem(new Error(PROBLEM_MESSAGES["schema-mismatch"]))?.text).toBe(
            "Launchpad's database needs attention. The instance operator needs to run the upgrade or restore procedure.",
        );
    });

    it("recognises a problem that crossed the wire as a plain object", () => {
        expect(describeProblem({ message: PROBLEM_MESSAGES["database-unavailable"] })?.code).toBe(
            "database-unavailable",
        );
    });

    it("returns null for anything else, and never repeats an unknown message", () => {
        for (const value of [
            new Error("Failed to connect to 10.0.0.5:5432"),
            new Error("launchpad:something-else"),
            new Error(""),
            "launchpad:database-unavailable",
            null,
            undefined,
            { message: 3 },
        ]) {
            expect(describeProblem(value)).toBeNull();
        }
    });
});

describe("messageForProblem", () => {
    it("is specific for an unreachable database and otherwise the API's title", () => {
        expect(
            messageForProblem({
                code: "database-unavailable",
                title: "The database is unavailable.",
            }),
        ).toBe("Launchpad can't reach its database. Try again in a moment.");
        expect(messageForProblem({ code: "forbidden", title: "Nope." })).toBe("Nope.");
        expect(messageForProblem(null)).toBe("The request failed.");
    });
});
