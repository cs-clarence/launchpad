import type { Database } from "@launchpad-kit/database";
import { type Kysely, sql } from "kysely";
import { requireAliasesOn, type AliasDeps } from "./aliases";
import type { Principal } from "./authorization";
import { requireDeploymentsOn } from "./apps";
import { appendDeploymentEvent } from "./deployment-claims";
import { withModelMutation } from "./deployment-recovery";
import { ServiceError } from "./errors";
import { isUuid } from "./ids";
import { recordAudit, requireMembership } from "./organizations";
import { reservePromotionOperation } from "./promotions";

type Db = Kysely<Database>;
const databaseNow = sql<Date>`clock_timestamp()`;
const FINISHED = ["succeeded", "failed", "cancelled"];

export type ShutdownBlocker =
    | "aliases-disabled"
    | "alias-in-progress"
    | "alias-needs-reconciliation"
    | "deployment-unfinished"
    | "deployment-needs-reconciliation"
    | "deployment-deleting";

// Called with the app row locked. Settles the shutdown once nothing can route to the app and every
// deployment is deleted. The app's identity, hostnames and names stay reserved permanently.
export async function finishShutdownIfDone(trx: Db, appId: string): Promise<boolean> {
    const app = await trx
        .selectFrom("app")
        .select(["id", "organization_id", "state"])
        .where("id", "=", appId)
        .executeTakeFirst();
    if (!app || app.state !== "shutting-down") return false;
    const live = await trx
        .selectFrom("deployment")
        .select("id")
        .where("app_id", "=", appId)
        .where("desired_state", "<>", "deleted")
        .executeTakeFirst();
    const routing = await trx
        .selectFrom("app_alias")
        .select("id")
        .where("app_id", "=", appId)
        .where("state", "not in", ["unbound", "withdrawn"])
        .executeTakeFirst();
    if (live || routing) return false;
    await trx
        .updateTable("app")
        .set({ state: "deleted", deleted_at: databaseNow })
        .where("id", "=", appId)
        .where("state", "=", "shutting-down")
        .returning("id")
        .executeTakeFirstOrThrow();
    await trx
        .insertInto("audit_event")
        .values({
            actor: "system",
            action: "app.shutdown-completed",
            target_type: "app",
            target_id: appId,
            organization_id: app.organization_id,
        })
        .execute();
    return true;
}

// Explicit, destructive, and resumable: each request advances as far as it safely can and reports
// what still blocks it. Nothing is destroyed until every alias route has been withdrawn and
// verified by the worker, and an uncertain route blocks it until an operator reconciles it.
// Lock order: app row, alias rows by id, deployment rows by id, then operation rows.
export async function requestAppShutdown(
    db: Db,
    principal: Principal,
    organizationId: string,
    appId: string,
    deps: AliasDeps,
    restrictTo?: string[] | null,
) {
    await requireMembership(db, principal, organizationId, "app:shutdown");
    requireDeploymentsOn(deps.settings);
    if (!isUuid(appId)) throw new ServiceError("not-found", "App not found.");
    return withModelMutation(db, deps.dataDir, async (trx) => {
        await requireMembership(trx, principal, organizationId, "app:shutdown");
        const found = await trx
            .selectFrom("app")
            .select(["id", "project_id", "state"])
            .where("id", "=", appId)
            .where("organization_id", "=", organizationId)
            .where("state", "<>", "deleted")
            .executeTakeFirst();
        if (!found || (restrictTo && !restrictTo.includes(found.project_id))) {
            throw new ServiceError("not-found", "App not found.");
        }
        const app = await trx
            .selectFrom("app")
            .select(["id", "state"])
            .where("id", "=", appId)
            .forUpdate()
            .executeTakeFirstOrThrow();
        if (app.state === "deleted") throw new ServiceError("not-found", "App not found.");
        const aliases = await trx
            .selectFrom("app_alias")
            .select(["id", "state", "target_deployment_id", "reserved_generation"])
            .where("app_id", "=", appId)
            .orderBy("id")
            .forUpdate()
            .execute();
        const deployments = await trx
            .selectFrom("deployment")
            .select(["id", "status", "desired_state"])
            .where("app_id", "=", appId)
            .orderBy("id")
            .forUpdate()
            .execute();

        if (app.state === "active") {
            await trx
                .updateTable("app")
                .set({ state: "shutting-down" })
                .where("id", "=", appId)
                .returning("id")
                .executeTakeFirstOrThrow();
            await recordAudit(trx, {
                actor: principal,
                action: "app.shutdown-requested",
                targetType: "app",
                targetId: appId,
                organizationId,
            });
        }

        const blockedBy = new Set<ShutdownBlocker>();
        let withdrawalsQueued = 0;
        let stable = true;
        for (const alias of aliases) {
            if (alias.state === "unbound" || alias.state === "withdrawn") continue;
            stable = false;
            if (alias.state === "bound") {
                try {
                    requireAliasesOn(deps);
                } catch {
                    blockedBy.add("aliases-disabled");
                    continue;
                }
                await reservePromotionOperation(
                    trx,
                    principal,
                    organizationId,
                    appId,
                    alias.id,
                    alias,
                    {
                        action: "withdraw",
                        target: null,
                        expected: String(alias.reserved_generation),
                        // A space is refused in a caller's key, so this cannot collide with one.
                        key: `shutdown ${alias.id}`,
                    },
                );
                withdrawalsQueued++;
            } else if (alias.state === "binding" || alias.state === "withdrawing") {
                blockedBy.add("alias-in-progress");
            } else {
                blockedBy.add("alias-needs-reconciliation");
            }
        }

        let deletionsQueued = 0;
        // Only with every route withdrawn and verified in an earlier pass, never in the same one.
        if (stable) {
            for (const deployment of deployments) {
                if (deployment.desired_state === "deleting") {
                    blockedBy.add("deployment-deleting");
                } else if (deployment.desired_state === "active") {
                    if (!FINISHED.includes(deployment.status)) {
                        blockedBy.add(
                            deployment.status === "reconciliation-needed"
                                ? "deployment-needs-reconciliation"
                                : "deployment-unfinished",
                        );
                        continue;
                    }
                    await trx
                        .insertInto("deployment_deletion_operation")
                        .values({
                            organization_id: organizationId,
                            app_id: appId,
                            deployment_id: deployment.id,
                            reason: "shutdown",
                            requested_by: principal.userId,
                        })
                        .execute();
                    await trx
                        .updateTable("deployment")
                        .set({ desired_state: "deleting", updated_at: databaseNow })
                        .where("id", "=", deployment.id)
                        .returning("id")
                        .executeTakeFirstOrThrow();
                    await appendDeploymentEvent(
                        trx,
                        { id: deployment.id, organization_id: organizationId },
                        "deleting",
                        "info",
                        "Deletion requested by app shutdown.",
                    );
                    deletionsQueued++;
                }
            }
            if (deletionsQueued) {
                await recordAudit(trx, {
                    actor: principal,
                    action: "app.shutdown-deletions-queued",
                    targetType: "app",
                    targetId: appId,
                    organizationId,
                    detail: `deployments=${deletionsQueued}`,
                });
            }
        }
        const done = await finishShutdownIfDone(trx, appId);
        return {
            appId,
            state: done ? ("deleted" as const) : ("shutting-down" as const),
            withdrawalsQueued,
            deletionsQueued,
            blockedBy: [...blockedBy],
        };
    });
}
