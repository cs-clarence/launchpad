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
export * from "./artifacts";
