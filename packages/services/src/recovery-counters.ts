import type { Database } from "@launchpad-kit/database";
import { type Kysely, sql } from "kysely";
import {
    assertNoActiveDeploymentImportBackends,
    assertNoPendingDeploymentImport,
    DeploymentRecoveryError,
    lockDeploymentRecovery,
    withDeploymentRecoveryMaintenance,
} from "./deployment-recovery";
import { MAX_GENERATION } from "./promotion-reserve";
import { compareRouterInventory, type RouterView } from "./router-inventory";

type Db = Kysely<Database>;

// Counters only ever rise: GREATEST, never a lower value, under the alias row lock. Runs inside
// the recovery maintenance lock (so no model writer can run) and refuses while an importer may
// still be live, exactly as recovery-clear does. The committed generation is not touched: only
// a verified outcome may claim that.
export async function raiseAliasCounters(db: Db, dataDir: string, view: RouterView) {
    return withDeploymentRecoveryMaintenance(db, async (connection) => {
        await assertNoPendingDeploymentImport(dataDir);
        await assertNoActiveDeploymentImportBackends(connection);
        const inventory = await view();
        return connection.transaction().execute(async (trx) => {
            await lockDeploymentRecovery(trx, true);
            const migrated = await sql<{ present: boolean }>`
                select to_regclass('public.app_alias') is not null as present`.execute(trx);
            if (!migrated.rows[0]!.present) {
                throw new DeploymentRecoveryError("Run migration 018 before raising counters.");
            }
            const report = await compareRouterInventory(trx, inventory);
            let raised = 0;
            for (const row of report.behind.toSorted((a, b) =>
                a.aliasId.localeCompare(b.aliasId),
            )) {
                await trx
                    .selectFrom("app_alias")
                    .select("id")
                    .where("id", "=", row.aliasId)
                    .forUpdate()
                    .executeTakeFirstOrThrow();
                await trx
                    .updateTable("app_alias")
                    .set({
                        reserved_generation: sql<string>`greatest(reserved_generation, ${row.router}::bigint)`,
                        updated_at: sql<Date>`clock_timestamp()`,
                    })
                    .where("id", "=", row.aliasId)
                    .execute();
                raised++;
            }
            if (raised > 0) {
                await trx
                    .insertInto("audit_event")
                    .values({
                        actor: "operator-cli",
                        action: "deployment.recovery-counters-raised",
                        target_type: "instance",
                        target_id: "self",
                        organization_id: null,
                        detail: `aliases=${raised}`,
                    })
                    .execute();
            }
            return {
                raised,
                unknownRoutes: report.unknownRoutes,
                unknownWithdrawn: report.unknownWithdrawn,
            };
        });
    });
}

// Withdraws one live route the router serves for a hostname Launchpad has no alias for, at the
// next generation. Refuses anything Launchpad knows, and anything that already serves nothing.
// Held under the recovery maintenance lock so no alias can be created for the hostname while it is
// judged unknown. The hostname stays reserved on the router for the old alias id.
export async function withdrawUnknownRoute(
    db: Db,
    hostname: string,
    router: {
        view: RouterView;
        withdraw(route: { aliasId: string; hostname: string; generation: string }): Promise<void>;
    },
) {
    return withDeploymentRecoveryMaintenance(db, async (connection) => {
        const inventory = await router.view();
        const report = await compareRouterInventory(connection, inventory);
        const route = inventory.routes.find((row) => row.hostname === hostname);
        if (!route || !report.unknownRoutes.includes(hostname)) {
            throw new DeploymentRecoveryError(
                "That hostname is not a live route the router serves for an alias Launchpad does not know.",
            );
        }
        const next = BigInt(route.generation) + 1n;
        if (next > MAX_GENERATION)
            throw new DeploymentRecoveryError("That route has no generations left.");
        await router.withdraw({ aliasId: route.aliasId, hostname, generation: next.toString() });
        await connection
            .insertInto("audit_event")
            .values({
                actor: "operator-cli",
                action: "deployment.unknown-route-withdrawn",
                target_type: "instance",
                target_id: "self",
                organization_id: null,
                detail: `hostname=${hostname};generation=${next}`,
            })
            .execute();
        return { hostname, generation: next.toString() };
    });
}
