import type { Database } from "@launchpad-kit/database";
import type { Kysely } from "kysely";

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

export interface CounterReport {
    // Aliases whose reserved counter is below the router's generation for their hostname.
    behind: { aliasId: string; hostname: string; database: string; router: string }[];
    // Routes serving a deployment for a hostname Launchpad has no alias for (or another alias's).
    unknownRoutes: string[];
    // Routes for such hostnames that serve nothing (a withdrawal): reported, never blocking.
    unknownWithdrawn: string[];
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
    const report: CounterReport = { behind: [], unknownRoutes: [], unknownWithdrawn: [] };
    for (const route of inventory.routes) {
        const alias = byHostname.get(route.hostname);
        if (!alias || alias.id !== route.aliasId) {
            (route.target ? report.unknownRoutes : report.unknownWithdrawn).push(route.hostname);
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
    report.behind.length > 0 || report.unknownRoutes.length > 0;
