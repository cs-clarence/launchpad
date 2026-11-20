import { createAliasSchema } from "@launchpad-kit/contracts";
import type { Database } from "@launchpad-kit/database";
import type { Kysely } from "kysely";
import { lockOrganizationQuota, requireDeploymentsOn, type AppDeps } from "./apps";
import type { AliasConfig, AliasSettings } from "./app-routing-config";
import type { Principal } from "./authorization";
import { withModelMutation } from "./deployment-recovery";
import { isUniqueViolation, ServiceError } from "./errors";
import { allocateHostname } from "./hostname-template";
import { parseInput, recordAudit, requireMembership } from "./organizations";

type Db = Kysely<Database>;

export interface AliasDeps extends AppDeps {
    aliases: AliasSettings;
}

const visible = (restrictTo: string[] | null | undefined, projectId: string) =>
    !restrictTo || restrictTo.includes(projectId);

export function requireAliasesOn(deps: AliasDeps): AliasConfig {
    requireDeploymentsOn(deps.settings);
    if (!deps.aliases.enabled) {
        throw new ServiceError("unavailable", "Aliases are turned off on this instance.");
    }
    return deps.aliases;
}

const ALIAS_COLUMNS = [
    "app_alias.id",
    "app_alias.app_id as appId",
    "app_alias.slug",
    "app_alias.hostname",
    "app_alias.state",
    "app_alias.target_deployment_id as targetDeploymentId",
    "app_alias.reserved_generation as reservedGeneration",
    "app_alias.committed_generation as committedGeneration",
    "app_alias.created_at as createdAt",
] as const;

// Generations are bigint: they cross every boundary as decimal strings, never as numbers.
const shape = <T extends { reservedGeneration: unknown; committedGeneration: unknown }>(
    row: T,
) => ({
    ...row,
    reservedGeneration: String(row.reservedGeneration),
    committedGeneration: String(row.committedGeneration),
});

// Creates an unbound alias: its permanent hostname and reservation, generation 0, and no route.
// Nothing contacts a router here. Lock order: quota lock, then the app row.
export async function createAlias(
    db: Db,
    principal: Principal,
    organizationId: string,
    appId: string,
    input: unknown,
    deps: AliasDeps,
    restrictTo?: string[] | null,
) {
    await requireMembership(db, principal, organizationId, "app:alias:manage");
    const config = requireAliasesOn(deps);
    const data = parseInput(createAliasSchema, input);
    try {
        return await withModelMutation(db, deps.dataDir, async (trx) => {
            await lockOrganizationQuota(trx, organizationId);
            await requireMembership(trx, principal, organizationId, "app:alias:manage");
            const app = await trx
                .selectFrom("app")
                .select(["id", "project_id"])
                .where("id", "=", appId)
                .where("organization_id", "=", organizationId)
                .where("state", "=", "active")
                .forUpdate()
                .executeTakeFirst();
            if (!app || !visible(restrictTo, app.project_id)) {
                throw new ServiceError("not-found", "App not found.");
            }
            const count = async (column: "app_id" | "organization_id", value: string) =>
                Number(
                    (
                        await trx
                            .selectFrom("app_alias")
                            .select((eb) => eb.fn.countAll<string>().as("n"))
                            .where(column, "=", value)
                            .where("state", "<>", "withdrawn")
                            .executeTakeFirstOrThrow()
                    ).n,
                );
            if ((await count("app_id", appId)) >= config.maxAliasesPerApp) {
                throw new ServiceError("conflict", "This app has too many aliases.");
            }
            if ((await count("organization_id", organizationId)) >= config.maxAliases) {
                throw new ServiceError("conflict", "This organization has too many aliases.");
            }
            const { hostname } = await allocateHostname({
                template: config.aliasTemplate,
                slug: data.slug,
                isTaken: async (name) =>
                    !!(await trx
                        .selectFrom("hostname_reservation")
                        .select("hostname")
                        .where("hostname", "=", name)
                        .executeTakeFirst()),
            });
            const alias = await trx
                .insertInto("app_alias")
                .values({
                    organization_id: organizationId,
                    app_id: appId,
                    slug: data.slug,
                    hostname,
                    created_by: principal.userId,
                })
                .returning(["id"])
                .executeTakeFirstOrThrow();
            await trx
                .insertInto("hostname_reservation")
                .values({
                    hostname,
                    owner_kind: "alias",
                    owner_id: alias.id,
                    organization_id: organizationId,
                })
                .execute();
            await recordAudit(trx, {
                actor: principal,
                action: "alias.created",
                targetType: "alias",
                targetId: alias.id,
                organizationId,
            });
            return shape(
                await trx
                    .selectFrom("app_alias")
                    .select([...ALIAS_COLUMNS])
                    .where("app_alias.id", "=", alias.id)
                    .executeTakeFirstOrThrow(),
            );
        });
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new ServiceError("conflict", "An alias with that slug already exists.");
        }
        throw error;
    }
}

export async function listAliases(
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
    const rows = await db
        .selectFrom("app_alias")
        .select([...ALIAS_COLUMNS])
        .where("app_alias.app_id", "=", appId)
        .where("app_alias.organization_id", "=", organizationId)
        .orderBy("app_alias.created_at")
        .orderBy("app_alias.id")
        .execute();
    return rows.map(shape);
}

export async function getAlias(
    db: Db,
    principal: Principal,
    organizationId: string,
    aliasId: string,
    restrictTo?: string[] | null,
) {
    await requireMembership(db, principal, organizationId, "app:read");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(aliasId)) {
        throw new ServiceError("not-found", "Alias not found.");
    }
    const row = await db
        .selectFrom("app_alias")
        .innerJoin("app", "app.id", "app_alias.app_id")
        .select([...ALIAS_COLUMNS, "app.project_id as projectId"])
        .where("app_alias.id", "=", aliasId)
        .where("app_alias.organization_id", "=", organizationId)
        .where("app.state", "<>", "deleted")
        .executeTakeFirst();
    if (!row || !visible(restrictTo, row.projectId)) {
        throw new ServiceError("not-found", "Alias not found.");
    }
    const { projectId: _projectId, ...alias } = row;
    return shape(alias);
}
