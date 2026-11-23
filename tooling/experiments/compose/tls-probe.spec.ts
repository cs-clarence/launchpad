import { expect, it } from "bun:test";
import { controlProbePassed, safeProbeOutcome } from "./tls-probe";

it("recognizes certificate verification errors without mistaking an unavailable server for refusal", () => {
    expect(controlProbePassed("untrusted", "UNABLE_TO_VERIFY_LEAF_SIGNATURE")).toBe(true);
    expect(controlProbePassed("untrusted", "ERR_TLS_CERT_ALTNAME_INVALID")).toBe(false);
    expect(controlProbePassed("wrong-name", "ERR_TLS_CERT_ALTNAME_INVALID")).toBe(true);
    expect(controlProbePassed("wrong-name", "UNABLE_TO_VERIFY_LEAF_SIGNATURE")).toBe(false);
    for (const error of ["TimeoutError", "ECONNREFUSED", "500"]) {
        expect(controlProbePassed("untrusted", error)).toBe(false);
        expect(controlProbePassed("wrong-name", error)).toBe(false);
        expect(controlProbePassed("plaintext", error)).toBe(false);
    }
    expect(controlProbePassed("plaintext", "ConnectionClosed")).toBe(true);
    expect(controlProbePassed("trusted", "200")).toBe(true);
    expect(safeProbeOutcome("password=fixture-password")).toBe("unrecognized");
});
