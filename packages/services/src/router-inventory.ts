import type { Database } from "@launchpad-kit/database";
import type { Kysely } from "kysely";
import type { RouterRead } from "./drift/types";

type Db = Kysely<Database>;

// What the router holds, as read through its authenticated control endpoint (the operator command
// builds this from the control client, which checks instance and epoch on every page).
export interface RouterInventory {
    instanceId: string;
    epoch: string;
    routes: {
        aliasId: string;
        hostname: string;
        operationId: string;
        generation: string;
        target: { deploymentId: string; hostname: string } | null;
    }[];
}
export type RouterView = () => Promise<RouterInventory>;

export function toDriftRouter(inventory: RouterInventory): RouterRead {
    return {
        epoch: inventory.epoch,
        routes: inventory.routes.map((r) => ({
            hostname: r.hostname,
            generation: BigInt(r.generation),
            operationId: r.operationId,
            targetDeploymentId: r.target?.deploymentId ?? null,
            targetHostname: r.target?.hostname ?? null,
        })),
    };
}

export interface CounterReport {
    // Aliases whose reserved counter is below the router's generation for their hostname.
    behind: { aliasId: string; hostname: string; database: string; router: string }[];
    // Routes serving a deployment for a hostname Launchpad has no alias for (or another alias's).
    unknownRoutes: string[];
    // Routes for such hostnames that serve nothing (a withdrawal): reported, never blocking.
    unknownWithdrawn: string[];
    // Hostnames the database knows under a different alias id than the router recorded, serving
    // or not. The router would refuse that alias's writes, so these always block.
    conflicting: string[];
}

export async function compareRouterInventory(
    db: Db,
    inventory: RouterInventory,
): Promise<CounterReport> {
    const aliases = await db
        .selectFrom("app_alias")
        .select(["id", "hostname", "reserved_generation"])
        .execute();
    const byHostname = new Map(aliases.map((alias) => [alias.hostname, alias]));
    const report: CounterReport = {
        behind: [],
        unknownRoutes: [],
        unknownWithdrawn: [],
        conflicting: [],
    };
    for (const route of inventory.routes) {
        const alias = byHostname.get(route.hostname);
        if (!alias) {
            (route.target ? report.unknownRoutes : report.unknownWithdrawn).push(route.hostname);
        } else if (alias.id !== route.aliasId) {
            report.conflicting.push(route.hostname);
        } else if (BigInt(route.generation) > BigInt(alias.reserved_generation)) {
            report.behind.push({
                aliasId: alias.id,
                hostname: alias.hostname,
                database: String(alias.reserved_generation),
                router: route.generation,
            });
        }
    }
    return report;
}

export const counterProblems = (report: CounterReport) =>
    report.behind.length > 0 || report.unknownRoutes.length > 0 || report.conflicting.length > 0;
