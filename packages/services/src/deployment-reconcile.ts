import type { Database } from "@launchpad-kit/database";
import { type Kysely, sql } from "kysely";
import { appendDeploymentEvent } from "./deployment-claims";
import { withModelMutation } from "./deployment-recovery";
import { ServiceError } from "./errors";

type Db = Kysely<Database>;

export type ReconcileOutcome = "succeeded" | "failed-clean" | "failed-owned" | "abandon";
const databaseNow = sql<Date>`clock_timestamp()`;

// Records what an operator observed on Dokku, by exact name, for work the worker could not
// settle. It never calls Dokku and never destroys or creates anything remote: a deployment
// that was held becomes settled, or a held deletion is released for the worker to continue.
// Lock order: app row, deployment row, then the operation row, as the design requires.
export async function reconcileDeployment(
    db: Db,
    dataDir: string,
    input: { deploymentId: string; outcome: ReconcileOutcome; attested: boolean },
) {
    if (!input.attested) {
        throw new ServiceError(
            "invalid",
            "Reconciling needs --i-have-verified-dokku-by-exact-name: check Dokku for this deployment's exact app name first.",
        );
    }
    return withModelMutation(db, dataDir, async (trx) => {
        const found = await trx
            .selectFrom("deployment")
            .select("app_id")
            .where("id", "=", input.deploymentId)
            .executeTakeFirst();
        if (!found) throw new ServiceError("not-found", "Deployment not found.");
        await trx
            .selectFrom("app")
            .select("id")
            .where("id", "=", found.app_id)
            .forUpdate()
            .executeTakeFirstOrThrow();
        const deployment = await trx
            .selectFrom("deployment")
            .select(["id", "organization_id", "status", "image_tag", "image_id", "step_pending"])
            .where("id", "=", input.deploymentId)
            .forUpdate()
            .executeTakeFirstOrThrow();
        const operation = await trx
            .selectFrom("deployment_deletion_operation")
            .select(["id", "organization_id", "deployment_id", "step_pending"])
            .where("deployment_id", "=", input.deploymentId)
            .where("status", "=", "reconciliation-needed")
            .forUpdate()
            .executeTakeFirst();

        let kind: "deletion" | "deployment";
        if (operation) {
            kind = "deletion";
            if (input.outcome !== "succeeded" && input.outcome !== "failed-clean") {
                throw new ServiceError(
                    "invalid",
                    "A deletion can only be recorded as succeeded or failed-clean.",
                );
            }
            // `succeeded`: the app is gone, so only the local image removal remains.
            // `failed-clean`: the destroy never took effect, so the worker destroys again.
            await trx
                .updateTable("deployment_deletion_operation")
                .set({
                    status: "queued",
                    step_pending: null,
                    ...(input.outcome === "succeeded" ? { step_done: "destroy" as const } : {}),
                    failure_code: null,
                    failure_message: null,
                    lease_owner: null,
                    lease_expires_at: null,
                    updated_at: databaseNow,
                })
                .where("id", "=", operation.id)
                .executeTakeFirstOrThrow();
        } else if (deployment.status === "reconciliation-needed") {
            kind = "deployment";
            if (input.outcome === "succeeded") {
                if (!deployment.image_tag || !deployment.image_id) {
                    throw new ServiceError(
                        "conflict",
                        "No image was recorded for this deployment, so it cannot be marked succeeded.",
                    );
                }
                await trx
                    .updateTable("deployment")
                    .set({
                        status: "succeeded",
                        step_done: "verify",
                        step_pending: null,
                        failure_code: null,
                        failure_message: null,
                        finished_at: databaseNow,
                        lease_owner: null,
                        lease_expires_at: null,
                        updated_at: databaseNow,
                    })
                    .where("id", "=", deployment.id)
                    .executeTakeFirstOrThrow();
            } else {
                // `failed-clean`: nothing of this deployment exists on Dokku, so nothing is
                // recorded as owned. `failed-owned`: its app exists, so deletion may destroy it.
                // `abandon`: unknown; what was recorded stays recorded, and a name that was never
                // recorded as created is never destroyed by deletion.
                await trx
                    .updateTable("deployment")
                    .set({
                        status: "failed",
                        step_pending: null,
                        ...(input.outcome === "failed-clean" ? { step_done: null } : {}),
                        ...(input.outcome === "failed-owned" && deployment.step_pending === "app"
                            ? { step_done: "app" as const }
                            : {}),
                        failure_code: {
                            "failed-clean": "reconciled-clean",
                            "failed-owned": "reconciled-owned",
                            abandon: "abandoned",
                        }[input.outcome],
                        failure_message: {
                            "failed-clean":
                                "An operator confirmed that nothing of this deployment exists.",
                            "failed-owned":
                                "An operator confirmed that this deployment's app exists.",
                            abandon:
                                "An operator abandoned this deployment after an unconfirmed step.",
                        }[input.outcome],
                        finished_at: databaseNow,
                        lease_owner: null,
                        lease_expires_at: null,
                        updated_at: databaseNow,
                    })
                    .where("id", "=", deployment.id)
                    .executeTakeFirstOrThrow();
            }
        } else {
            throw new ServiceError("conflict", "Nothing needs reconciling for this deployment.");
        }
        await appendDeploymentEvent(
            trx,
            deployment,
            "reconciled",
            "info",
            `An operator recorded the outcome: ${input.outcome}.`,
        );
        await trx
            .insertInto("audit_event")
            .values({
                actor: "operator-cli",
                action: "deployment.reconciled",
                target_type: "deployment",
                target_id: deployment.id,
                organization_id: deployment.organization_id,
                detail: `kind=${kind};outcome=${input.outcome}`,
            })
            .execute();
        return { kind, outcome: input.outcome };
    });
}
