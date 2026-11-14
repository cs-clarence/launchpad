import { createProjectSchema } from "@launchpad/contracts";
import type { Database } from "@launchpad/database";
import type { Kysely } from "kysely";
import type { Principal } from "./authorization";
import { isUniqueViolation, ServiceError } from "./errors";
import { parseInput, recordAudit, requireMembership } from "./organizations";

type Db = Kysely<Database>;

// Every query names the organization; a project in another organization is
// indistinguishable from one that does not exist.
// `restrictTo` is an API key's project allow-list; null or absent means all projects.
export async function listProjects(
    db: Db,
    principal: Principal,
    organizationId: string,
    restrictTo?: string[] | null,
) {
    await requireMembership(db, principal, organizationId, "project:read");
    if (restrictTo && restrictTo.length === 0) return [];
    let query = db
        .selectFrom("project")
        .select(["id", "slug", "name", "created_at as createdAt"])
        .where("organization_id", "=", organizationId);
    if (restrictTo) {
        query = query.where("id", "in", restrictTo);
    }
    return query.orderBy("created_at").execute();
}

export async function createProject(
    db: Db,
    principal: Principal,
    organizationId: string,
    input: unknown,
) {
    await requireMembership(db, principal, organizationId, "project:create");
    const data = parseInput(createProjectSchema, input);
    try {
        return await db.transaction().execute(async (trx) => {
            const project = await trx
                .insertInto("project")
                .values({
                    organization_id: organizationId,
                    slug: data.slug,
                    name: data.name,
                    created_by: principal.userId,
                })
                .returning(["id", "slug", "name"])
                .executeTakeFirstOrThrow();
            await recordAudit(trx, {
                actor: principal,
                action: "project.created",
                targetType: "project",
                targetId: project.id,
                organizationId,
            });
            return project;
        });
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new ServiceError("conflict", "A project with that slug already exists.");
        }
        throw error;
    }
}
