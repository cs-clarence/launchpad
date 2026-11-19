import type { Database, DeletionStatus } from "@launchpad-kit/database";
import type { Kysely } from "kysely";

// Read-only inventory of the preview-era (mutable app) records, for retiring them before the
// immutable-deployment model's migration (docs/design/deployment-modes.md, "Legacy retirement").
// It lists exactly what the database recorded: Dokku app names, hostnames and image tags. It
// contacts nothing, changes nothing and never offers to delete anything; what to do about each
// app is the operator's, by exact name, through the guarded deletion path.

export interface PreviewInventoryItem {
    previewId: string;
    organizationId: string;
    slug: string;
    appName: string;
    hostname: string;
    state: "active" | "deleting" | "deleted";
    expiresAt: Date | null;
    imageTags: string[];
    // Deployment jobs not yet finished, and those parked for an administrator.
    unfinishedDeployments: number;
    heldDeployments: number;
    // The preview's deletion operation while it is not yet succeeded.
    deletion: Exclude<DeletionStatus, "succeeded"> | null;
}

export interface PreviewInventory {
    // Every recorded preview, deleted ones included, oldest first.
    items: PreviewInventoryItem[];
    // Previews that must be deleted, or whose work must finish, before the migration.
    blocking: PreviewInventoryItem[];
    // True when every preview is terminally deleted and no deployment or deletion is unfinished.
    readyToRetire: boolean;
}

const UNFINISHED = ["queued", "preparing", "building", "deploying", "verifying"] as const;

export async function inventoryPreviews(db: Kysely<Database>): Promise<PreviewInventory> {
    const previews = await db
        .selectFrom("preview")
        .select([
            "id",
            "organization_id",
            "slug",
            "app_name",
            "hostname",
            "desired_state",
            "expires_at",
        ])
        .orderBy("created_at")
        .orderBy("id")
        .execute();
    const deployments = await db
        .selectFrom("deployment")
        .select(["preview_id", "status", "image_tag"])
        .execute();
    const deletions = await db
        .selectFrom("deletion_operation")
        .select(["preview_id", "status"])
        .where("status", "<>", "succeeded")
        .execute();

    const items = previews.map((p): PreviewInventoryItem => {
        const mine = deployments.filter((d) => d.preview_id === p.id);
        const open = deletions.find((d) => d.preview_id === p.id);
        return {
            previewId: p.id,
            organizationId: p.organization_id,
            slug: p.slug,
            appName: p.app_name,
            hostname: p.hostname,
            state: p.desired_state,
            expiresAt: p.expires_at,
            imageTags: [
                ...new Set(mine.map((d) => d.image_tag).filter((t): t is string => t !== null)),
            ].toSorted(),
            unfinishedDeployments: mine.filter((d) =>
                (UNFINISHED as readonly string[]).includes(d.status),
            ).length,
            heldDeployments: mine.filter((d) => d.status === "reconciliation-needed").length,
            deletion: open ? (open.status as Exclude<DeletionStatus, "succeeded">) : null,
        };
    });
    const blocking = items.filter(
        (i) =>
            i.state !== "deleted" ||
            i.unfinishedDeployments > 0 ||
            i.heldDeployments > 0 ||
            i.deletion !== null,
    );
    return { items, blocking, readyToRetire: blocking.length === 0 };
}
