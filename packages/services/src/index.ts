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
export * from "./drift";
export * from "./deployment-recovery";
