export const controlProbes = [
    ["trusted", "https://router:3081/healthz"],
    ["untrusted", "https://router:3081/healthz"],
    ["wrong-name", "https://127.0.0.1:3081/healthz"],
    ["plaintext", "http://router:3081/healthz"],
] as const;

type ProbeMode = (typeof controlProbes)[number][0];
const untrusted = new Set([
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "UNABLE_TO_GET_ISSUER_CERT",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "CERT_UNTRUSTED",
]);

export function controlProbePassed(mode: ProbeMode, outcome: string): boolean {
    switch (mode) {
        case "trusted":
            return outcome === "200";
        case "untrusted":
            return untrusted.has(outcome);
        case "wrong-name":
            return outcome === "ERR_TLS_CERT_ALTNAME_INVALID";
        case "plaintext":
            return /^(?:400|ECONNRESET|EPIPE|ConnectionClosed|SocketError)$/.test(outcome);
    }
}

export function safeProbeOutcome(outcome: string): string {
    return /^[A-Za-z0-9_]{1,64}$/.test(outcome) ? outcome : "unrecognized";
}
