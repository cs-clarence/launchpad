import type { aliasSchema, deploymentSchema } from "@launchpad-kit/contracts";
import type { z } from "zod";

export type Alias = z.infer<typeof aliasSchema>;
export type Deployment = z.infer<typeof deploymentSchema>;

export function eligibleTargets(alias: Alias, deployments: Deployment[]) {
    return deployments.filter(
        (deployment) =>
            deployment.appId === alias.appId &&
            deployment.id !== alias.targetDeploymentId &&
            deployment.status === "succeeded" &&
            deployment.desiredState === "active",
    );
}

export function routeIntent(base: string, alias: Alias, target?: string) {
    const aliasUrl = `${base}/aliases/${encodeURIComponent(alias.id)}`;
    const method = target === undefined ? "DELETE" : "POST";
    const path = target === undefined ? aliasUrl : `${aliasUrl}/promotions`;
    const json = {
        expectedGeneration: alias.reservedGeneration,
        ...(target === undefined ? {} : { targetDeploymentId: target }),
    };
    return { method, path, json, fingerprint: JSON.stringify([method, path, json]) } as const;
}
