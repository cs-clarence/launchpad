// Typed, allowlisted Dokku operations over SSH with a pinned host key. There is no
// generic command runner on purpose: see README.md.
export type { DokkuConnection } from "./connection";
export { createDokkuClient, classify, type DokkuClient, type DokkuClientOptions } from "./client";
export { DokkuError, needsReconciliation, type DokkuErrorKind } from "./errors";
// Only the types, so a transport can be injected. The real one is created by the client:
// exporting it would let a caller run commands outside the allowlist.
export type { Transport, TransportRequest, TransportResult } from "./transport";
export { DEFAULT_APP_NAME } from "./validate";
