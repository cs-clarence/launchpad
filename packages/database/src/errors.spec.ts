import { describe, expect, it } from "vitest";
import { classifyDatabaseError, SchemaMismatchError } from "./errors";

// Shapes captured from Bun SQL against a real PostgreSQL 17 (see
// docs/plans/rehearsal-defects-fixes-2.md, "Spike findings").
const driver = (code: string) => Object.assign(new Error("Failed to connect"), { code });
const server = (errno: string) =>
    Object.assign(new Error("server said no"), { code: "ERR_POSTGRES_SERVER_ERROR", errno });

describe("classifyDatabaseError", () => {
    it.each([
        ["connection refused", driver("ERR_POSTGRES_CONNECTION_REFUSED"), "unreachable"],
        ["connection timeout", driver("ERR_POSTGRES_CONNECTION_TIMEOUT"), "unreachable"],
        ["terminated by an administrator", server("57P01"), "unreachable"],
        ["server shutting down", server("57P03"), "unreachable"],
        ["too many connections", server("53300"), "unreachable"],
        ["connection exception class", server("08006"), "unreachable"],
        ["missing table", server("42P01"), "schema"],
        ["missing column", server("42703"), "schema"],
        ["schema mismatch", new SchemaMismatchError("behind"), "schema"],
        ["syntax error", server("42601"), null],
        ["bad password", server("28P01"), null],
        ["statement timeout", server("57014"), null],
        ["unique violation", server("23505"), null],
        ["destroyed pool", new Error("driver has already been destroyed"), null],
        ["plain error", new Error("boom"), null],
        ["unknown driver label", driver("ERR_POSTGRES_SOMETHING_ELSE"), null],
        ["a string", "ERR_POSTGRES_CONNECTION_REFUSED", null],
        ["null", null, null],
        ["undefined", undefined, null],
    ])("%s", (_name, error, expected) => {
        expect(classifyDatabaseError(error)).toBe(expected);
    });
});
