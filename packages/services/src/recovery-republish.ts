import { randomUUID } from "node:crypto";
import type { Database } from "@launchpad-kit/database";
import type { Kysely } from "kysely";
import {
    assertNoActiveDeploymentImportBackends,
    assertNoPendingDeploymentImport,
    DeploymentRecoveryError,
    lockDeploymentRecovery,
    readRecoveryMarker,
    requireRecoveryGrace,
    withDeploymentRecoveryMaintenance,
} from "./deployment-recovery";
import { isDeploymentPinned, OPEN_OPERATION_STATUSES } from "./pins";
import { MAX_GENERATION } from "./promotion-reserve";
import type { RouterInventory } from "./router-inventory";

type Db = Kysely<Database>;
type Target = { deploymentId: string; hostname: string };
type Authority = Pick<RouterInventory, "instanceId" | "epoch">;
type Route = RouterInventory["routes"][number];

export interface RecoveryRepublishRouter {
    observe(hostname: string): Promise<Authority & { route: Route | null }>;
    register(target: Target): Promise<unknown>;
    replace(write: Omit<Route, "target"> & { targetDeploymentId: string | null }): Promise<unknown>;
    serves(hostname: string, target: Target | null): Promise<boolean>;
}

// Reconcile only the explicitly named alias. A failed write/readback leaves the gate and
// DB history intact. A retry observes the actual router fence before choosing its generation.
export function republishRecoveryAlias(
    db: Db,
    dataDir: string,
    aliasId: string,
    router: RecoveryRepublishRouter,
    routerEpochUnrecorded = false,
    // The restored committed target cannot serve (for example its Dokku app is gone). Instead of
    // republishing it, write a tombstone, verify nothing is served, and record a withdrawal. This
    // overrides the restored database's committed target, so it is never the default.
    committedAppExists?: (appName: string) => Promise<boolean>,
) {
    const withdrawUnservableTarget = committedAppExists !== undefined;
    return withDeploymentRecoveryMaintenance(db, async (connection) => {
        await assertNoPendingDeploymentImport(dataDir);
        await assertNoActiveDeploymentImportBackends(connection);
        const marker = await readRecoveryMarker(dataDir);
        requireRecoveryGrace(marker);
        if (!marker || marker === "damaged")
            throw new DeploymentRecoveryError("Recovery marker is required.");
        const gate = await connection
            .selectFrom("instance_state")
            .select("value")
            .where("key", "=", "deployment_recovery")
            .executeTakeFirst();
        if (gate?.value !== "blocked") {
            throw new DeploymentRecoveryError(
                "Republishing requires the database recovery gate to be blocked. If clear was interrupted, retry recovery-clear.",
            );
        }
        const alias = await connection
            .selectFrom("app_alias")
            .select([
                "id",
                "hostname",
                "app_id",
                "organization_id",
                "created_by",
                "target_deployment_id",
                "reserved_generation",
                "committed_generation",
            ])
            .where("id", "=", aliasId)
            .executeTakeFirst();
        if (!alias) throw new DeploymentRecoveryError("That alias does not exist.");
        const observation = await router.observe(alias.hostname);
        if (observation.epoch === marker.routerEpoch)
            throw new DeploymentRecoveryError(
                "Rotate the router since restore began before republishing.",
            );
        if (
            (marker.routerEpoch === null || marker.routerEpochNote === "from-epoch-file") &&
            !routerEpochUnrecorded
        ) {
            throw new DeploymentRecoveryError(
                "Verify the router rotation and pass --router-epoch-unrecorded.",
            );
        }
        const route = observation.route;
        if (route && (route.aliasId !== alias.id || route.hostname !== alias.hostname))
            throw new DeploymentRecoveryError(
                "The router records this hostname for a different alias.",
            );

        const committed = BigInt(alias.committed_generation);
        const reserved = BigInt(alias.reserved_generation);
        if (withdrawUnservableTarget && (committed === 0n || alias.target_deployment_id === null)) {
            throw new DeploymentRecoveryError(
                "Only an alias with a committed target can have an unservable target withdrawn.",
            );
        }
        const previousTarget = alias.target_deployment_id;
        const targetRow =
            alias.target_deployment_id === null || withdrawUnservableTarget
                ? null
                : await connection
                      .selectFrom("deployment")
                      .select(["id", "hostname", "status", "desired_state"])
                      .where("id", "=", alias.target_deployment_id)
                      .executeTakeFirstOrThrow();
        if (targetRow && (targetRow.status !== "succeeded" || targetRow.desired_state !== "active"))
            throw new DeploymentRecoveryError(
                "The restored committed target is not an active, successful deployment.",
            );
        const target = targetRow && { deploymentId: targetRow.id, hostname: targetRow.hostname };
        const last =
            committed === 0n
                ? undefined
                : await connection
                      .selectFrom("promotion_operation")
                      .select("id")
                      .where("alias_id", "=", alias.id)
                      .where("generation", "=", alias.committed_generation)
                      .where("status", "=", "succeeded")
                      .executeTakeFirst();
        const open = await connection
            .selectFrom("promotion_operation")
            .select("generation")
            .where("alias_id", "=", aliasId)
            .where("status", "in", [...OPEN_OPERATION_STATUSES])
            .orderBy("generation")
            .limit(1)
            .executeTakeFirst();
        if (committedAppExists) {
            const committedTarget = await connection
                .selectFrom("deployment")
                .select(["id", "hostname", "app_name"])
                .where("id", "=", previousTarget!)
                .executeTakeFirstOrThrow();
            // A target that still serves must be republished, never withdrawn.
            if (
                await router.serves(alias.hostname, {
                    deploymentId: committedTarget.id,
                    hostname: committedTarget.hostname,
                })
            ) {
                throw new DeploymentRecoveryError(
                    "The committed target still serves; republish it without --withdraw-unservable-target.",
                );
            }
            // A proxy failure could be transient. Only an authoritative exact-name
            // Dokku read can establish that the app is gone; read errors propagate.
            if ((await committedAppExists(committedTarget.app_name)) !== false) {
                throw new DeploymentRecoveryError(
                    "The committed Dokku app still exists; repair it and republish instead.",
                );
            }
        }
        const matches =
            !withdrawUnservableTarget &&
            (committed === 0n
                ? !route ||
                  (route.target === null &&
                      BigInt(route.generation) <= reserved &&
                      (!open || BigInt(route.generation) < BigInt(open.generation)))
                : route?.generation === alias.committed_generation &&
                  (!last || route.operationId === last.id) &&
                  (route.target?.deploymentId ?? null) === (target?.deploymentId ?? null) &&
                  (route.target?.hostname ?? null) === (target?.hostname ?? null));
        if (matches) {
            if (!(await router.serves(alias.hostname, target)))
                throw new DeploymentRecoveryError(
                    "The committed route matches but its served identity did not verify.",
                );
            // A matching alias's existing intent still owns its remaining generation.
            return {
                generation: route?.generation ?? alias.committed_generation,
                changed: false,
                superseded: 0,
            };
        }
        const live = BigInt(route?.generation ?? "0");
        const next = (live > reserved ? live : reserved) + 1n;
        if (next > MAX_GENERATION)
            throw new DeploymentRecoveryError("That alias has no generations left.");
        const generation = next.toString();
        const operationId = randomUUID();
        if (target) await router.register(target);
        await router.replace({
            hostname: alias.hostname,
            aliasId: alias.id,
            operationId,
            generation,
            targetDeploymentId: target?.deploymentId ?? null,
        });
        const verified = await router.observe(alias.hostname);
        if (
            verified.epoch !== observation.epoch ||
            verified.instanceId !== observation.instanceId ||
            verified.route?.operationId !== operationId ||
            verified.route.aliasId !== alias.id ||
            verified.route.hostname !== alias.hostname ||
            verified.route.generation !== generation ||
            (verified.route.target?.deploymentId ?? null) !== (target?.deploymentId ?? null) ||
            (verified.route.target?.hostname ?? null) !== (target?.hostname ?? null) ||
            !(await router.serves(alias.hostname, target))
        ) {
            throw new DeploymentRecoveryError(
                "Republished route did not verify; keep recovery blocked and retry.",
            );
        }
        return connection.transaction().execute(async (trx) => {
            await lockDeploymentRecovery(trx, true);
            const operations = await trx
                .selectFrom("promotion_operation")
                .select([
                    "id",
                    "superseded_by_operation_id",
                    "previous_target_deployment_id",
                    "desired_target_deployment_id",
                ])
                .where("alias_id", "=", aliasId)
                .where("status", "in", [...OPEN_OPERATION_STATUSES])
                .execute();
            const now = new Date();
            const observed = {
                observed_epoch: verified.epoch,
                observed_generation: generation,
                observed_operation_id: operationId,
                observed_target_deployment_id: target?.deploymentId ?? null,
                finished_at: now,
                updated_at: now,
            };
            await trx
                .insertInto("promotion_operation")
                .values({
                    ...observed,
                    id: operationId,
                    organization_id: alias.organization_id,
                    app_id: alias.app_id,
                    alias_id: aliasId,
                    action: target ? "bind" : "withdraw",
                    idempotency_key: `recovery-${operationId}`,
                    previous_target_deployment_id: withdrawUnservableTarget
                        ? previousTarget
                        : (target?.deploymentId ?? null),
                    desired_target_deployment_id: target?.deploymentId ?? null,
                    expected_generation: alias.committed_generation,
                    generation,
                    // The creator is retained by FK and supplies the required user
                    // reference. The maintenance audit attributes the repair to the CLI.
                    requested_by: alias.created_by,
                    status: "succeeded",
                    step_done: "verify",
                })
                .execute();
            for (const op of operations) {
                await trx
                    .updateTable("promotion_operation")
                    .set({
                        ...observed,
                        status: "superseded",
                        superseded_by_operation_id: op.superseded_by_operation_id ?? operationId,
                        lease_owner: null,
                        lease_expires_at: null,
                        step_pending: null,
                    })
                    .where("id", "=", op.id)
                    .execute();
            }
            // A never-bound alias can remain reusable even if a fence tombstone was required.
            await trx
                .updateTable("app_alias")
                .set({
                    reserved_generation: generation,
                    committed_generation: committed === 0n ? "0" : generation,
                    target_deployment_id: target?.deploymentId ?? null,
                    state: target ? "bound" : committed === 0n ? "unbound" : "withdrawn",
                    updated_at: now,
                })
                .where("id", "=", aliasId)
                .execute();
            if (withdrawUnservableTarget) {
                // As a verified withdrawal does: the hostname stays fenced on the router and is
                // no longer held for the alias.
                await trx
                    .updateTable("hostname_reservation")
                    .set({ released_at: now })
                    .where("owner_kind", "=", "alias")
                    .where("owner_id", "=", aliasId)
                    .where("released_at", "is", null)
                    .execute();
            }
            const released = new Set([
                ...(withdrawUnservableTarget ? [previousTarget] : []),
                ...operations.flatMap((op) => [
                    op.previous_target_deployment_id,
                    op.desired_target_deployment_id,
                ]),
            ]);
            for (const id of released) {
                if (id && !(await isDeploymentPinned(trx, id))) {
                    await trx
                        .updateTable("deployment")
                        .set({ last_unpinned_at: now, updated_at: now })
                        .where("id", "=", id)
                        .execute();
                }
            }
            await trx
                .insertInto("audit_event")
                .values({
                    actor: "operator-cli",
                    action: "deployment.recovery-alias-republished",
                    target_type: "alias",
                    target_id: aliasId,
                    organization_id: alias.organization_id,
                    detail: JSON.stringify({
                        generation,
                        operationId,
                        attributedUserId: alias.created_by,
                        target: target?.deploymentId ?? null,
                        withdrawnUnservableTarget: withdrawUnservableTarget ? previousTarget : null,
                        superseded: operations.map((op) => op.id),
                        routerEpochUnrecorded,
                    }),
                })
                .execute();
            return { generation, changed: true, superseded: operations.length };
        });
    });
}
