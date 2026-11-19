import type { Database } from "@launchpad-kit/database";
import { type Kysely, sql } from "kysely";
import type { Principal } from "./authorization";
import { ServiceError } from "./errors";

type Db = Kysely<Database>;

// How the instance is doing, for the operator: that the database answers, and what is stored.
// Counts only: no ids, names or text that came from a remote system. Workers, queues and
// deployments return with the immutable model, which defines their own status.
export async function getStatus(db: Db, principal: Principal) {
    if (principal.instanceRole !== "operator") {
        throw new ServiceError("forbidden", "Only the instance operator may read this.");
    }
    const artifacts = await db
        .selectFrom("artifact")
        .select([
            sql<number>`count(*)::int`.as("n"),
            sql<number>`coalesce(sum(size_bytes), 0)::float8`.as("bytes"),
        ])
        .where("collected_at", "is", null)
        .executeTakeFirstOrThrow();
    return {
        generatedAt: new Date().toISOString(),
        dependencies: { database: "ok" as const },
        artifacts: { stored: artifacts.n, bytes: artifacts.bytes },
        warnings: [] as string[],
    };
}
