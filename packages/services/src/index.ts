export function getControllerInfo() {
    return { name: "launchpad", phase: "bootstrap" } as const;
}

export * from "./authorization";
export * from "./errors";
export * from "./organizations";
export * from "./projects";
export * from "./invitations";
export * from "./contracts";
export * from "./api-keys";
export * from "./archive";
export * from "./artifact-config";
export * from "./artifacts";
export * from "./artifact-gc";
export * from "./status";
export * from "./hostname-template";
export * from "./app-routing-config";
export * from "./controller-config";
export * from "./apps";
export { MAX_PAGE_LIMIT, parsePageQuery, type Page, type PageRequest } from "./pagination";
export * from "./aliases";
export * from "./promotions";
export { requestAppShutdown, type ShutdownBlocker } from "./app-shutdown";
export * from "./promotion-claims";
export * from "./router-credentials";
export * from "./router-inventory";
export * from "./recovery-counters";
export * from "./recovery-republish";
export * from "./deployments";
export * from "./deployment-claims";
export * from "./deployment-deletion";
export * from "./deployment-reconcile";
export * from "./reconciliation-requests";
export * from "./drift";
export * from "./deployment-recovery";
export * from "./pins";
