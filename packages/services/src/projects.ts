import { createProjectSchema } from "@launchpad-kit/contracts";
import type { Database } from "@launchpad-kit/database";
import type { Kysely } from "kysely";
import type { Principal } from "./authorization";
import { isUniqueViolation, ServiceError } from "./errors";
import { parseInput, recordAudit, requireMembership } from "./organizations";
import { emptyPage, orderedRows, pageRows, type PageRequest, type PageSpec } from "./pagination";

type Db = Kysely<Database>;

// Every query names the organization; a project in another organization is
// indistinguishable from one that does not exist.
// `restrictTo` is an API key's project allow-list; null or absent means all projects.
const projectsSpec = (organizationId: string): PageSpec => ({
    route: "projects",
    organizationId,
    keys: [
        { ref: "project.created_at", type: "timestamptz" },
        { ref: "project.id", type: "uuid" },
    ],
});

function projectsQuery(db: Db, organizationId: string, restrictTo?: string[] | null) {
    let query = db
        .selectFrom("project")
        .select(["project.id", "project.slug", "project.name", "project.created_at as createdAt"])
        .where("project.organization_id", "=", organizationId);
    if (restrictTo) {
        query = query.where("project.id", "in", restrictTo);
    }
    return query;
}

export async function listProjects(
    db: Db,
    principal: Principal,
    organizationId: string,
    restrictTo?: string[] | null,
) {
    await requireMembership(db, principal, organizationId, "project:read");
    if (restrictTo && restrictTo.length === 0) return [];
    return orderedRows(projectsQuery(db, organizationId, restrictTo), projectsSpec(organizationId));
}

export async function listProjectsPage(
    db: Db,
    principal: Principal,
    organizationId: string,
    page: PageRequest,
    restrictTo?: string[] | null,
) {
    await requireMembership(db, principal, organizationId, "project:read");
    if (restrictTo && restrictTo.length === 0) {
        return emptyPage<Awaited<ReturnType<typeof listProjects>>[number]>();
    }
    return pageRows(
        projectsQuery(db, organizationId, restrictTo),
        projectsSpec(organizationId),
        page,
    );
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
