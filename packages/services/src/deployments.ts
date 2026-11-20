import { randomUUID } from "node:crypto";
import { createDeploymentSchema, parseDuration } from "@launchpad-kit/contracts";
import type { Database } from "@launchpad-kit/database";
import { type Kysely, sql } from "kysely";
import { lockOrganizationQuota, requireDeploymentsOn, type AppDeps } from "./apps";
import type { Principal } from "./authorization";
import { withModelMutation } from "./deployment-recovery";
import { isUniqueViolation, ServiceError } from "./errors";
import { allocateHostname } from "./hostname-template";
import { opaqueId } from "./ids";
import { parseInput, recordAudit, requireMembership } from "./organizations";

type Db = Kysely<Database>;

const visible = (restrictTo: string[] | null | undefined, projectId: string) =>
    !restrictTo || restrictTo.includes(projectId);

const UNFINISHED = [
    "queued",
    "preparing",
    "building",
    "deploying",
    "verifying",
    "reconciliation-needed",
] as const;

const SUMMARY = [
    "deployment.id",
    "deployment.app_id as appId",
    "deployment.status",
    "deployment.desired_state as desiredState",
    "deployment.hostname",
    "deployment.spa",
    "deployment.created_at as createdAt",
    "deployment.finished_at as finishedAt",
    "deployment.preview_expires_at as expiresAt",
    "deployment.failure_code as failureCode",
    "deployment.failure_message as failureMessage",
] as const;

// Allocates a Dokku name the shared registry does not hold. Never reuses or truncates.
async function allocateAppName(trx: Db): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
        const name = `lp-${opaqueId(10)}`;
        const taken = await trx
            .selectFrom("dokku_name_reservation")
            .select("app_name")
            .where("app_name", "=", name)
            .executeTakeFirst();
        if (!taken) return name;
    }
    throw new ServiceError("conflict", "A free app name could not be allocated; try again.");
}

// Queues one deployment. Nothing executes it here: a worker claims it later. Everything that must
// agree commits together: the deployment, both permanent reservations and its first event.
export async function createDeployment(
    db: Db,
    principal: Principal,
    organizationId: string,
    appId: string,
    input: unknown,
    deps: AppDeps,
    restrictTo?: string[] | null,
) {
    await requireMembership(db, principal, organizationId, "app:deploy");
    const config = requireDeploymentsOn(deps.settings);
    const data = parseInput(createDeploymentSchema, input);
    let ttlSeconds = config.defaultTtlSeconds;
    if (data.ttl !== undefined) {
        const requested = parseDuration(data.ttl)!;
        if (requested > config.maxTtlSeconds) {
            throw new ServiceError("invalid", "ttl is longer than this instance allows.");
        }
        ttlSeconds = requested;
    }
    try {
        return await withModelMutation(db, deps.dataDir, async (trx) => {
            // Quota lock first, then the app row; no network I/O inside this transaction.
            await lockOrganizationQuota(trx, organizationId);
            await requireMembership(trx, principal, organizationId, "app:deploy");
            const app = await trx
                .selectFrom("app")
                .select(["id", "slug", "project_id"])
                .where("id", "=", appId)
                .where("organization_id", "=", organizationId)
                .where("state", "=", "active")
                .forUpdate()
                .executeTakeFirst();
            if (!app || !visible(restrictTo, app.project_id)) {
                throw new ServiceError("not-found", "App not found.");
            }
            const artifact = await trx
                .selectFrom("artifact")
                .select("id")
                .where("id", "=", data.artifactId)
                .where("organization_id", "=", organizationId)
                .where("collected_at", "is", null)
                .executeTakeFirst();
            if (!artifact) throw new ServiceError("not-found", "Artifact not found.");
            if (restrictTo) {
                // Artifacts carry no project of their own: a restricted key may use only one that
                // was uploaded through this app's project, whoever created it.
                const provenance = await trx
                    .selectFrom("artifact_project")
                    .select("artifact_id")
                    .where("artifact_id", "=", artifact.id)
                    .where("project_id", "=", app.project_id)
                    .executeTakeFirst();
                if (!provenance) throw new ServiceError("not-found", "Artifact not found.");
            }
            const unfinished = await trx
                .selectFrom("deployment")
                .select("id")
                .where("app_id", "=", appId)
                .where("status", "in", [...UNFINISHED])
                .executeTakeFirst();
            if (unfinished) {
                throw new ServiceError(
                    "conflict",
                    "This app already has a deployment in progress.",
                );
            }
            const count = async (column: "app_id" | "organization_id", value: string) =>
                Number(
                    (
                        await trx
                            .selectFrom("deployment")
                            .select((eb) => eb.fn.countAll<string>().as("n"))
                            .where(column, "=", value)
                            .where("desired_state", "<>", "deleted")
                            .executeTakeFirstOrThrow()
                    ).n,
                );
            if ((await count("app_id", appId)) >= config.maxDeploymentsPerApp) {
                throw new ServiceError("conflict", "This app has too many deployments.");
            }
            if ((await count("organization_id", organizationId)) >= config.maxDeployments) {
                throw new ServiceError("conflict", "This organization has too many deployments.");
            }

            const id = randomUUID();
            const { hostname } = await allocateHostname({
                template: config.deploymentTemplate,
                slug: app.slug,
                isTaken: async (name) =>
                    !!(await trx
                        .selectFrom("hostname_reservation")
                        .select("hostname")
                        .where("hostname", "=", name)
                        .executeTakeFirst()),
            });
            const appName = await allocateAppName(trx);
            const deployment = await trx
                .insertInto("deployment")
                .values({
                    id,
                    organization_id: organizationId,
                    app_id: appId,
                    artifact_id: artifact.id,
                    spa: data.spa ?? false,
                    app_name: appName,
                    hostname,
                    requested_by: principal.userId,
                    preview_expires_at: sql<Date>`now() + make_interval(secs => ${ttlSeconds})`,
                })
                .returning(["id"])
                .executeTakeFirstOrThrow();
            await trx
                .insertInto("hostname_reservation")
                .values({
                    hostname,
                    owner_kind: "deployment",
                    owner_id: id,
                    organization_id: organizationId,
                })
                .execute();
            await trx
                .insertInto("dokku_name_reservation")
                .values({
                    app_name: appName,
                    owner_kind: "deployment",
                    owner_id: id,
                    organization_id: organizationId,
                })
                .execute();
            await trx
                .insertInto("app_deployment_event")
                .values({
                    organization_id: organizationId,
                    deployment_id: id,
                    seq: 1,
                    phase: "queued",
                    message: "Queued.",
                })
                .execute();
            await recordAudit(trx, {
                actor: principal,
                action: "deployment.created",
                targetType: "deployment",
                targetId: id,
                organizationId,
            });
            return trx
                .selectFrom("deployment")
                .select([...SUMMARY])
                .where("deployment.id", "=", deployment.id)
                .executeTakeFirstOrThrow();
        });
    } catch (error) {
        // The app lock serializes requests for one app, so a unique violation here is a hostname
        // or Dokku-name collision with another organization's concurrent request.
        if (isUniqueViolation(error)) {
            throw new ServiceError("conflict", "The deployment could not be queued; try again.");
        }
        throw error;
    }
}

async function visibleDeployment(
    db: Db,
    organizationId: string,
    deploymentId: string,
    restrictTo?: string[] | null,
) {
    const row = await db
        .selectFrom("deployment")
        .innerJoin("app", "app.id", "deployment.app_id")
        .select([...SUMMARY, "app.project_id as projectId"])
        .where("deployment.id", "=", deploymentId)
        .where("deployment.organization_id", "=", organizationId)
        .where("app.state", "<>", "deleted")
        .executeTakeFirst();
    if (!row || !visible(restrictTo, row.projectId)) {
        throw new ServiceError("not-found", "Deployment not found.");
    }
    return row;
}

export async function getDeployment(
    db: Db,
    principal: Principal,
    organizationId: string,
    deploymentId: string,
    restrictTo?: string[] | null,
) {
    await requireMembership(db, principal, organizationId, "app:read");
    const { projectId: _projectId, ...deployment } = await visibleDeployment(
        db,
        organizationId,
        deploymentId,
        restrictTo,
    );
    return deployment;
}

export async function listDeployments(
    db: Db,
    principal: Principal,
    organizationId: string,
    appId: string,
    restrictTo?: string[] | null,
) {
    await requireMembership(db, principal, organizationId, "app:read");
    const app = await db
        .selectFrom("app")
        .select("project_id")
        .where("id", "=", appId)
        .where("organization_id", "=", organizationId)
        .where("state", "<>", "deleted")
        .executeTakeFirst();
    if (!app || !visible(restrictTo, app.project_id)) {
        throw new ServiceError("not-found", "App not found.");
    }
    return db
        .selectFrom("deployment")
        .select([...SUMMARY])
        .where("deployment.app_id", "=", appId)
        .where("deployment.organization_id", "=", organizationId)
        .orderBy("deployment.created_at", "desc")
        .orderBy("deployment.id")
        .execute();
}

// Events in order, after `afterSeq`, at most `limit` (default 100, at most 500).
export async function listDeploymentEvents(
    db: Db,
    principal: Principal,
    organizationId: string,
    deploymentId: string,
    options: { afterSeq?: number; limit?: number } = {},
    restrictTo?: string[] | null,
) {
    await requireMembership(db, principal, organizationId, "app:read");
    await visibleDeployment(db, organizationId, deploymentId, restrictTo);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    return db
        .selectFrom("app_deployment_event")
        .select(["seq", "phase", "level", "message", "created_at as createdAt"])
        .where("deployment_id", "=", deploymentId)
        .where("organization_id", "=", organizationId)
        .where("seq", ">", options.afterSeq ?? 0)
        .orderBy("seq")
        .limit(limit)
        .execute();
}
