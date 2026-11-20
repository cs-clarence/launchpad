import { describe, expect, it } from "vitest";
import type { DriftFinding, DriftReport, FindingCode } from "./drift/types";
import { assessRecoveryEvidence } from "./recovery-evidence";

const report = (...findings: DriftFinding[]): DriftReport => ({
    findings,
    inFlight: [],
    ignoredAppCount: 0,
    sources: { dokku: "ok", router: "ok", probe: "ok", archives: "ok" },
});

const finding = (code: FindingCode, severity: DriftFinding["severity"] = "high"): DriftFinding => ({
    code,
    severity,
    action: "Investigate.",
    resources: [{ kind: "deployment", id: "exact-id" }],
});

describe("recovery findings", () => {
    it("accepts only exact current external findings, and returns the full evidence to audit", () => {
        const missing = finding("archive-missing");
        const evidence = report(missing, finding("orphan-app", "medium"));
        expect(assessRecoveryEvidence(evidence, [])).toEqual({ accepted: [], blocking: [missing] });
        expect(assessRecoveryEvidence(evidence, ["archive-missing:exact-id"])).toEqual({
            accepted: [{ key: "archive-missing:exact-id", finding: missing }],
            blocking: [],
        });
        expect(() => assessRecoveryEvidence(evidence, ["archive-missing:other"])).toThrow(
            "--accept",
        );
        expect(() =>
            assessRecoveryEvidence(evidence, Array(2).fill("archive-missing:exact-id")),
        ).toThrow("--accept");
    });

    it.each([
        "alias-router-ahead",
        "alias-router-behind",
        "alias-target-conflict",
        "router-unknown-route",
        "router-epoch-mismatch",
        "owner-without-reservation",
        "stale-unpin",
    ] as const)("never accepts %s", (code) => {
        const alarm = finding(code, code === "alias-router-ahead" ? "medium" : "high");
        expect(assessRecoveryEvidence(report(alarm), []).blocking).toEqual([alarm]);
        expect(() => assessRecoveryEvidence(report(alarm), [`${code}:exact-id`])).toThrow(
            "--accept",
        );
    });
});
