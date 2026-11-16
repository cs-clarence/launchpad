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
export * from "./previews";
export * from "./archive";
export * from "./artifact-config";
export * from "./artifacts";
export * from "./deployments";
export * from "./lifecycle";
export * from "./deletions";
export * from "./expiry";
export * from "./artifact-gc";
export * from "./lifecycle-run";
