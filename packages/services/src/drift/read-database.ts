import type { Database } from "@launchpad-kit/database";
import { type Kysely, sql } from "kysely";
import { OPEN_OPERATION_STATUSES } from "../pins";
import type { DriftDatabase, DriftDeployment } from "./types";

const MAX_ROWS = 100_000;

function bounded<T>(rows: T[]): T[] {
    if (rows.length > MAX_ROWS) throw new Error("The drift snapshot exceeds its row limit.");
    return rows;
}

// Each snapshot is internally consistent. Remote reads happen between two short,
// read-only transactions, never while holding a transaction open on SSH or HTTP.
export async function readDriftDatabase(db: Kysely<Database>): Promise<DriftDatabase> {
    return db
        .transaction()
        .setIsolationLevel("repeatable read")
        .execute(async (trx) => {
            await sql`set transaction read only`.execute(trx);
            await sql`set local statement_timeout = '10s'`.execute(trx);
            const deployments = bounded(
                await trx
                    .selectFrom("deployment")
                    .leftJoin("artifact", "artifact.id", "deployment.artifact_id")
                    .select([
                        "deployment.id",
                        "deployment.organization_id",
                        "deployment.app_id",
                        "deployment.app_name",
                        "deployment.hostname",
                        "deployment.status",
                        "deployment.desired_state",
                        "deployment.last_unpinned_at",
                        "artifact.storage_key",
                    ])
                    .orderBy("deployment.id")
                    .limit(MAX_ROWS + 1)
                    .execute(),
            );
            const aliases = bounded(
                await trx
                    .selectFrom("app_alias")
                    .select([
                        "id",
                        "app_id",
                        "hostname",
                        "state",
                        "reserved_generation",
                        "committed_generation",
                        "target_deployment_id",
                    ])
                    .orderBy("id")
                    .limit(MAX_ROWS + 1)
                    .execute(),
            );
            const operations = bounded(
                await trx
                    .selectFrom("promotion_operation")
                    .select([
                        "id",
                        "alias_id",
                        "status",
                        "generation",
                        "lease_expires_at",
                        "step_pending",
                        "step_done",
                        "previous_target_deployment_id",
                        "desired_target_deployment_id",
                    ])
                    .orderBy("id")
                    .limit(MAX_ROWS + 1)
                    .execute(),
            );
            // This is a permanent identity registry, not just active allocations.
            // Released entries and their retired deployment owners remain comparable.
            const reservations = bounded(
                await trx
                    .selectFrom("hostname_reservation")
                    .select(["hostname", "owner_kind", "owner_id"])
                    .orderBy("hostname")
                    .limit(MAX_ROWS + 1)
                    .execute(),
            );
            const names = bounded(
                await trx
                    .selectFrom("dokku_name_reservation")
                    .select("app_name")
                    .orderBy("app_name")
                    .limit(MAX_ROWS + 1)
                    .execute(),
            );

            const references = new Map<string, string[]>();
            for (const alias of aliases) {
                if (alias.target_deployment_id !== null) {
                    const ids = references.get(alias.target_deployment_id) ?? [];
                    ids.push(alias.id);
                    references.set(alias.target_deployment_id, ids);
                }
            }
            const everPinned = new Set<string>(references.keys());
            const uncertain = new Set<string>();
            const committedOperations = new Map<string, string>();
            const open = new Set<string>(OPEN_OPERATION_STATUSES);
            const committed = new Map(aliases.map((a) => [a.id, a.committed_generation]));
            for (const op of operations) {
                if (op.status === "succeeded" && op.generation === committed.get(op.alias_id)) {
                    committedOperations.set(op.alias_id, op.id);
                }
                for (const id of [
                    op.previous_target_deployment_id,
                    op.desired_target_deployment_id,
                ]) {
                    if (id === null) continue;
                    everPinned.add(id);
                    if (open.has(op.status)) uncertain.add(id);
                }
            }
            return {
                deployments: deployments.map((d): DriftDeployment => ({
                    id: d.id,
                    organizationId: d.organization_id,
                    appId: d.app_id,
                    dokkuAppName: d.app_name,
                    hostname: d.hostname,
                    status:
                        d.desired_state === "deleted"
                            ? "retired"
                            : d.desired_state === "deleting"
                              ? "pending"
                              : d.status === "succeeded"
                                ? "succeeded"
                                : d.status === "failed" || d.status === "cancelled"
                                  ? "failed"
                                  : "pending",
                    referencedByAliasIds: references.get(d.id) ?? [],
                    inUncertainChain: uncertain.has(d.id),
                    everPinned: everPinned.has(d.id),
                    lastUnpinnedAt: d.last_unpinned_at,
                    artifactKey: d.storage_key,
                })),
                aliases: aliases.map((a) => ({
                    id: a.id,
                    appId: a.app_id,
                    hostname: a.hostname,
                    state: a.state,
                    reservedGeneration: BigInt(a.reserved_generation),
                    committedGeneration: BigInt(a.committed_generation),
                    targetDeploymentId: a.target_deployment_id,
                    lastOperationId: committedOperations.get(a.id) ?? null,
                })),
                operations: operations.map((op) => ({
                    id: op.id,
                    aliasId: op.alias_id,
                    generation: BigInt(op.generation),
                    status: op.status,
                    leaseExpiresAt: op.lease_expires_at,
                    dispatched: op.step_pending !== null || op.step_done !== null,
                })),
                reservations: reservations.map((r) => ({
                    hostname: r.hostname,
                    ownerKind: r.owner_kind,
                    ownerId: r.owner_id,
                })),
                legacyPreviewIds: [],
                knownAppNames: names.map((n) => n.app_name),
            };
        });
}
