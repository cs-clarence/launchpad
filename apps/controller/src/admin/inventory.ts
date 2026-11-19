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
    // Pending intent or any leftover lease field, even on a terminal job.
    // Expiry is not proof that a remote operation finished.
    unsettledDeployments: number;
    unsettledDeletions: number;
    // The preview's deletion operation while it is not yet succeeded.
    deletion: Exclude<DeletionStatus, "succeeded"> | null;
}

export interface PreviewInventory {
    // Every recorded preview, deleted ones included, oldest first.
    items: PreviewInventoryItem[];
    // Previews that must be deleted, or whose work must finish, before the migration.
    blocking: PreviewInventoryItem[];
    // True when all previews are deleted and jobs have terminal status, no
    // pending intent and no leftover lease fields. Not proof of remote settling.
    readyToRetire: boolean;
}

const UNFINISHED = ["queued", "preparing", "building", "deploying", "verifying"] as const;

const unsettled = (row: {
    step_pending: unknown;
    lease_owner: unknown;
    lease_expires_at: unknown;
}) => row.step_pending !== null || row.lease_owner !== null || row.lease_expires_at !== null;

export async function inventoryPreviews(db: Kysely<Database>): Promise<PreviewInventory> {
    // One snapshot for the three reads: a deletion that finishes between them must not give a
    // "deleting" preview with no open deletion.
    const { previews, deployments, deletions } = await db
        .transaction()
        .setIsolationLevel("repeatable read")
        .execute(async (trx) => ({
            previews: await trx
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
                .execute(),
            deployments: await trx
                .selectFrom("deployment")
                .select([
                    "preview_id",
                    "status",
                    "image_tag",
                    "step_pending",
                    "lease_owner",
                    "lease_expires_at",
                ])
                .execute(),
            deletions: await trx
                .selectFrom("deletion_operation")
                .select(["preview_id", "status", "step_pending", "lease_owner", "lease_expires_at"])
                .execute(),
        }));

    const items = previews.map((p): PreviewInventoryItem => {
        const mine = deployments.filter((d) => d.preview_id === p.id);
        const myDeletions = deletions.filter((d) => d.preview_id === p.id);
        const open = myDeletions.find((d) => d.status !== "succeeded");
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
            unsettledDeployments: mine.filter(unsettled).length,
            unsettledDeletions: myDeletions.filter(unsettled).length,
            deletion: open ? (open.status as Exclude<DeletionStatus, "succeeded">) : null,
        };
    });
    const blocking = items.filter(
        (i) =>
            i.state !== "deleted" ||
            i.unfinishedDeployments > 0 ||
            i.heldDeployments > 0 ||
            i.unsettledDeployments > 0 ||
            i.unsettledDeletions > 0 ||
            i.deletion !== null,
    );
    return { items, blocking, readyToRetire: blocking.length === 0 };
}
