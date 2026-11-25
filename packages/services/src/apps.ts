import { createAppSchema } from "@launchpad-kit/contracts";
import type { Database } from "@launchpad-kit/database";
import { type Kysely, sql } from "kysely";
import type { DeploymentConfig, DeploymentSettings } from "./app-routing-config";
import type { Principal } from "./authorization";
import { withModelMutation } from "./deployment-recovery";
import { isUniqueViolation, ServiceError } from "./errors";
import { parseInput, recordAudit, requireMembership } from "./organizations";
import { emptyPage, orderedRows, pageRows, type PageRequest, type PageSpec } from "./pagination";

type Db = Kysely<Database>;

export interface AppDeps {
    dataDir: string;
    settings: DeploymentSettings;
}

// `restrictTo` is an API key's project allow-list (null or absent: every project). A project
// outside it is indistinguishable from one that does not exist.
const visible = (restrictTo: string[] | null | undefined, projectId: string) =>
    !restrictTo || restrictTo.includes(projectId);

export function requireDeploymentsOn(settings: DeploymentSettings): DeploymentConfig {
    if (!settings.enabled) {
        throw new ServiceError("unavailable", "Deployments are turned off on this instance.");
    }
    return settings;
}

// One quota lock per organization, taken before any app or deployment row so every quota check
// and its insert serialize. The order is the schema map's: quota lock, then the app row.
export async function lockOrganizationQuota(trx: Db, organizationId: string) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`deployments:quota:${organizationId}`}, 0))`.execute(
        trx,
    );
}

const APP_COLUMNS = [
    "app.id",
    "app.project_id as projectId",
    "app.slug",
    "app.state",
    "app.created_at as createdAt",
] as const;

export async function createApp(
    db: Db,
    principal: Principal,
    organizationId: string,
    projectId: string,
    input: unknown,
    deps: AppDeps,
    restrictTo?: string[] | null,
) {
    await requireMembership(db, principal, organizationId, "app:deploy");
    if (!visible(restrictTo, projectId)) throw new ServiceError("not-found", "Project not found.");
    const config = requireDeploymentsOn(deps.settings);
    const data = parseInput(createAppSchema, input);
    try {
        return await withModelMutation(db, deps.dataDir, async (trx) => {
            await lockOrganizationQuota(trx, organizationId);
            // Authority is re-read under the lock: a caller removed meanwhile creates nothing.
            await requireMembership(trx, principal, organizationId, "app:deploy");
            const project = await trx
                .selectFrom("project")
                .select("id")
                .where("id", "=", projectId)
                .where("organization_id", "=", organizationId)
                .executeTakeFirst();
            if (!project) throw new ServiceError("not-found", "Project not found.");
            const count = await trx
                .selectFrom("app")
                .select((eb) => eb.fn.countAll<string>().as("n"))
                .where("organization_id", "=", organizationId)
                .where("state", "<>", "deleted")
                .executeTakeFirstOrThrow();
            if (Number(count.n) >= config.maxApps) {
                throw new ServiceError("conflict", "This organization has too many apps.");
            }
            const app = await trx
                .insertInto("app")
                .values({
                    organization_id: organizationId,
                    project_id: projectId,
                    slug: data.slug,
                    created_by: principal.userId,
                })
                .returning([
                    "id",
                    "project_id as projectId",
                    "slug",
                    "state",
                    "created_at as createdAt",
                ])
                .executeTakeFirstOrThrow();
            await recordAudit(trx, {
                actor: principal,
                action: "app.created",
                targetType: "app",
                targetId: app.id,
                organizationId,
            });
            return app;
        });
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new ServiceError("conflict", "An app with that slug already exists.");
        }
        throw error;
    }
}

type AppSummary = Awaited<ReturnType<typeof listApps>>[number];

const appsSpec = (organizationId: string): PageSpec => ({
    route: "apps",
    organizationId,
    keys: [
        { ref: "app.created_at", type: "timestamptz" },
        { ref: "app.id", type: "uuid" },
    ],
});

function appsQuery(db: Db, organizationId: string, restrictTo?: string[] | null) {
    let query = db
        .selectFrom("app")
        .select([...APP_COLUMNS])
        .where("app.organization_id", "=", organizationId)
        .where("app.state", "<>", "deleted");
    if (restrictTo) query = query.where("app.project_id", "in", restrictTo);
    return query;
}

export async function listApps(
    db: Db,
    principal: Principal,
    organizationId: string,
    restrictTo?: string[] | null,
) {
    await requireMembership(db, principal, organizationId, "app:read");
    if (restrictTo && restrictTo.length === 0) return [];
    return orderedRows(appsQuery(db, organizationId, restrictTo), appsSpec(organizationId));
}

export async function listAppsPage(
    db: Db,
    principal: Principal,
    organizationId: string,
    page: PageRequest,
    restrictTo?: string[] | null,
) {
    await requireMembership(db, principal, organizationId, "app:read");
    if (restrictTo && restrictTo.length === 0) return emptyPage<AppSummary>();
    return pageRows(appsQuery(db, organizationId, restrictTo), appsSpec(organizationId), page);
}

export async function getApp(
    db: Db,
    principal: Principal,
    organizationId: string,
    appId: string,
    restrictTo?: string[] | null,
) {
    await requireMembership(db, principal, organizationId, "app:read");
    const app = await db
        .selectFrom("app")
        .select([...APP_COLUMNS])
        .where("app.id", "=", appId)
        .where("app.organization_id", "=", organizationId)
        .where("app.state", "<>", "deleted")
        .executeTakeFirst();
    if (!app || !visible(restrictTo, app.projectId)) {
        throw new ServiceError("not-found", "App not found.");
    }
    return app;
}
