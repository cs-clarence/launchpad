import type { Database } from "@launchpad-kit/database";
import { type Kysely, sql } from "kysely";
import {
    assertNoActiveDeploymentImportBackends,
    assertNoPendingDeploymentImport,
    DeploymentRecoveryError,
    lockDeploymentRecovery,
    withDeploymentRecoveryMaintenance,
} from "./deployment-recovery";
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
                const updated = await trx
                    .updateTable("app_alias")
                    .set({
                        reserved_generation: sql<string>`greatest(reserved_generation, ${row.router}::bigint)`,
                        updated_at: sql<Date>`clock_timestamp()`,
                    })
                    .where("id", "=", row.aliasId)
                    .returning("id")
                    .executeTakeFirstOrThrow();
                if (updated) raised++;
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
