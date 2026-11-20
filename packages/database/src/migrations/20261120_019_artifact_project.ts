import { type Kysely, sql } from "kysely";

// Frozen in time: raw SQL on Kysely<any>, never app types. Forward-only.
// Artifacts are organization-owned and deduplicated by digest, so the same archive can be
// uploaded through several projects. This records every project an artifact was uploaded
// through; a project-restricted API key may deploy only artifacts uploaded through the app's own
// project. Older artifacts have no rows, which refuses them to restricted keys.
export async function up(db: Kysely<any>): Promise<void> {
    await sql`
        CREATE TABLE public.artifact_project (
            artifact_id uuid NOT NULL,
            organization_id text NOT NULL,
            project_id uuid NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (artifact_id, project_id),
            FOREIGN KEY (organization_id, artifact_id)
                REFERENCES public.artifact(organization_id, id) ON DELETE RESTRICT,
            FOREIGN KEY (organization_id, project_id)
                REFERENCES public.project(organization_id, id) ON DELETE RESTRICT
        )
    `.execute(db);
    await sql`CREATE INDEX artifact_project_project_idx
        ON public.artifact_project(organization_id, project_id)`.execute(db);
}
