import { createHash, randomInt } from "node:crypto";
import { createPreviewSchema } from "@launchpad/contracts";
import type { Database } from "@launchpad/database";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import type { Principal } from "./authorization";
import { ServiceError } from "./errors";
import { parseInput, recordAudit, requireMembership } from "./organizations";

type Db = Kysely<Database>;

export const MAX_PREVIEWS_PER_ORGANIZATION = 10;
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const LIST_LIMIT = 100;

export interface PreviewDeps {
    // The registrable domain previews are served from. It is separate from the
    // controller's own domain (see the organization-roles decision).
    previewDomain: string;
    // Live previews per organization. Defaults to MAX_PREVIEWS_PER_ORGANIZATION.
    maxPreviews?: number;
}

export const PREVIEW_DOMAIN_PATTERN =
    /^(?=.{1,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function opaqueId(length: number): string {
    let id = "";
    for (let i = 0; i < length; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
    return id;
}

// The name that reaches Dokku is generated here and never derived from user input.
export function generatePreviewNames(slug: string, domain: string) {
    const id = opaqueId(10);
    return { appName: `lp-${id}`, hostname: `${slug}-${id.slice(0, 6)}.${domain}` };
}

const keySchema = z.string().min(1).max(128);

// Stable across key order, so the same payload always hashes the same.
export function hashRequest(payload: Record<string, string>): string {
    const canonical = JSON.stringify(
        Object.keys(payload)
            .toSorted()
            .map((k) => [k, payload[k]]),
    );
    return createHash("sha256").update(canonical).digest("hex");
}

function shape(row: {
    id: string;
    project_id: string;
    slug: string;
    hostname: string;
    desired_state: "active" | "deleting" | "deleted";
    active_deployment_id: string | null;
    created_at: Date;
}) {
    return {
        id: row.id,
        projectId: row.project_id,
        slug: row.slug,
        hostname: row.hostname,
        state: row.desired_state,
        activeDeploymentId: row.active_deployment_id,
        createdAt: row.created_at,
    };
}

const COLUMNS = [
    "id",
    "project_id",
    "slug",
    "hostname",
    "desired_state",
    "active_deployment_id",
    "created_at",
] as const;

// Keyset pagination in (created_at, id) order. `after` is the id of the last preview
// of the previous page (the `nextCursor` it returned); every preview is reachable.
export async function listPreviews(
    db: Db,
    principal: Principal,
    organizationId: string,
    options: { projectId?: string; after?: string; projectIds?: string[] | null } = {},
) {
    await requireMembership(db, principal, organizationId, "preview:read");
    let query = db
        .selectFrom("preview")
        .select(COLUMNS)
        .where("organization_id", "=", organizationId)
        .where("desired_state", "!=", "deleted");
    if (options.projectId !== undefined) {
        if (!z.uuid().safeParse(options.projectId).success) return { items: [], nextCursor: null };
        query = query.where("project_id", "=", options.projectId);
    }
    // A project-limited key sees only previews of its own projects.
    if (options.projectIds) query = query.where("project_id", "in", options.projectIds);
    if (options.after !== undefined) {
        if (!z.uuid().safeParse(options.after).success) {
            throw new ServiceError("invalid", "The cursor is not valid.");
        }
        query = query.where(
            sql<boolean>`(created_at, id) > (select created_at, id from preview where id = ${options.after} and organization_id = ${organizationId})`,
        );
    }
    const rows = await query
        .orderBy("created_at")
        .orderBy("id")
        .limit(LIST_LIMIT + 1)
        .execute();
    const items = rows.slice(0, LIST_LIMIT).map(shape);
    return { items, nextCursor: rows.length > LIST_LIMIT ? items[items.length - 1]!.id : null };
}

export async function getPreview(
    db: Db,
    principal: Principal,
    organizationId: string,
    previewId: string,
) {
    await requireMembership(db, principal, organizationId, "preview:read");
    if (!z.uuid().safeParse(previewId).success) {
        throw new ServiceError("not-found", "Preview not found.");
    }
    const row = await db
        .selectFrom("preview")
        .select(COLUMNS)
        .where("organization_id", "=", organizationId)
        .where("id", "=", previewId)
        .where("desired_state", "!=", "deleted")
        .executeTakeFirst();
    if (!row) throw new ServiceError("not-found", "Preview not found.");
    return shape(row);
}

// Creates the record and its generated names only. Nothing is deployed and Dokku is
// not contacted. A repeated request key with the same payload returns the first
// preview; with a different payload it is a conflict.
export async function createPreview(
    db: Db,
    principal: Principal,
    organizationId: string,
    projectId: string,
    input: unknown,
    deps: PreviewDeps,
    idempotencyKey?: string,
) {
    await requireMembership(db, principal, organizationId, "preview:create");
    // A bad cap must fail loudly: NaN or Infinity would silently remove it.
    const maxPreviews = deps.maxPreviews ?? MAX_PREVIEWS_PER_ORGANIZATION;
    if (!Number.isSafeInteger(maxPreviews) || maxPreviews < 1) {
        throw new Error("maxPreviews must be a positive integer.");
    }
    if (!PREVIEW_DOMAIN_PATTERN.test(deps.previewDomain)) {
        throw new Error("The preview domain is not a valid lowercase domain name.");
    }
    if (!z.uuid().safeParse(projectId).success) {
        throw new ServiceError("not-found", "Project not found.");
    }
    const data = parseInput(createPreviewSchema, input);
    const key = idempotencyKey === undefined ? undefined : parseInput(keySchema, idempotencyKey);
    const requestHash = hashRequest({ projectId, slug: data.slug });
    const endpoint = "preview.create";
    const bound = principal.credentialId ?? principal.userId;

    const created = await db.transaction().execute(async (trx) => {
        // One creator per organization at a time: the preview cap, the slug check
        // and the idempotency record below cannot be raced by concurrent requests.
        await sql`select pg_advisory_xact_lock(hashtextextended(${`previews:${organizationId}`}, 0))`.execute(
            trx,
        );
        // Authority is re-read under the lock, so a caller removed while waiting
        // cannot still create.
        await requireMembership(trx, principal, organizationId, "preview:create");

        if (key !== undefined) {
            await trx
                .deleteFrom("idempotency_key")
                .where("expires_at", "<=", sql<Date>`now()`)
                .execute();
            const seen = await trx
                .selectFrom("idempotency_key")
                .select(["request_hash", "resource_id"])
                .where("organization_id", "=", organizationId)
                .where("principal", "=", bound)
                .where("endpoint", "=", endpoint)
                .where("key", "=", key)
                .executeTakeFirst();
            if (seen) {
                if (seen.request_hash !== requestHash || !seen.resource_id) {
                    throw new ServiceError(
                        "conflict",
                        "That idempotency key was used with a different request.",
                    );
                }
                const first = await trx
                    .selectFrom("preview")
                    .select(COLUMNS)
                    .where("organization_id", "=", organizationId)
                    .where("id", "=", seen.resource_id)
                    .executeTakeFirst();
                if (first) return shape(first);
                // The first preview is gone; fall through and create a new one.
            }
        }

        const project = await trx
            .selectFrom("project")
            .select("id")
            .where("organization_id", "=", organizationId)
            .where("id", "=", projectId)
            .executeTakeFirst();
        if (!project) throw new ServiceError("not-found", "Project not found.");

        const taken = await trx
            .selectFrom("preview")
            .select("id")
            .where("project_id", "=", projectId)
            .where("slug", "=", data.slug)
            .executeTakeFirst();
        if (taken) {
            throw new ServiceError("conflict", "A preview with that name already exists.");
        }
        const live = await trx
            .selectFrom("preview")
            .select((eb) => eb.fn.countAll<string>().as("n"))
            .where("organization_id", "=", organizationId)
            .where("desired_state", "=", "active")
            .executeTakeFirstOrThrow();
        if (Number(live.n) >= maxPreviews) {
            throw new ServiceError("conflict", "This organization has too many live previews.");
        }

        // `do nothing` rather than catching a unique violation: an error would abort
        // the whole transaction. A generated-name collision just draws a new name.
        let row;
        for (let attempt = 0; attempt < 5 && !row; attempt++) {
            const names = generatePreviewNames(data.slug, deps.previewDomain);
            row = await trx
                .insertInto("preview")
                .values({
                    organization_id: organizationId,
                    project_id: projectId,
                    slug: data.slug,
                    app_name: names.appName,
                    hostname: names.hostname,
                    active_deployment_id: null,
                    created_by: principal.userId,
                })
                .onConflict((oc) => oc.doNothing())
                .returning(COLUMNS)
                .executeTakeFirst();
        }
        if (!row) throw new Error("Could not generate a unique preview name.");

        if (key !== undefined) {
            await trx
                .insertInto("idempotency_key")
                .values({
                    organization_id: organizationId,
                    principal: bound,
                    endpoint,
                    key,
                    request_hash: requestHash,
                    resource_id: row.id,
                    expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
                })
                .onConflict((oc) =>
                    oc
                        .columns(["organization_id", "principal", "endpoint", "key"])
                        .doUpdateSet({ request_hash: requestHash, resource_id: row.id }),
                )
                .execute();
        }
        await recordAudit(trx, {
            actor: principal,
            action: "preview.created",
            targetType: "preview",
            targetId: row.id,
            organizationId,
        });
        return shape(row);
    });
    return created;
}

// The project a preview belongs to, for deciding what a project-limited key may reach. A
// missing or malformed id is the same not-found.
export async function previewProjectId(
    db: Db,
    principal: Principal,
    organizationId: string,
    previewId: string,
) {
    // A non-member gets not-found, like every other lookup here.
    await requireMembership(db, principal, organizationId, "preview:read");
    if (!z.uuid().safeParse(previewId).success) {
        throw new ServiceError("not-found", "Preview not found.");
    }
    const row = await db
        .selectFrom("preview")
        .select("project_id")
        .where("organization_id", "=", organizationId)
        .where("id", "=", previewId)
        .executeTakeFirst();
    if (!row) throw new ServiceError("not-found", "Preview not found.");
    return row.project_id;
}
