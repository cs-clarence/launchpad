// Typed, allowlisted Dokku operations over SSH with a pinned host key. There is no
// generic command runner on purpose: see README.md.
export type { DokkuConnection } from "./connection";
export { createDokkuClient, classify, type DokkuClient, type DokkuClientOptions } from "./client";
export { DokkuError, needsReconciliation, type DokkuErrorKind } from "./errors";
export {
    SshTransport,
    type Transport,
    type TransportRequest,
    type TransportResult,
} from "./transport";
export { DEFAULT_APP_NAME } from "./validate";
