import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveArtifactPath, type ArchiveLimits, type DeployContext } from "@launchpad/services";
import type { Docker } from "./docker";
import { extractSite } from "./extract";
import { dockerfile, imageTagFor, nginxConf } from "./template";

export interface BuildDeps {
    dataDir: string;
    limits: ArchiveLimits;
    docker: Docker;
    baseImage: string;
}

// Builds this deployment's image from its stored artifact and Launchpad's fixed
// template. Idempotent: the tag is derived from the deployment, and a repeated build
// replaces it. The scratch directory is removed whatever happens.
export async function buildImage(
    context: DeployContext,
    deps: BuildDeps,
    signal: AbortSignal,
): Promise<{ imageTag: string }> {
    const tag = imageTagFor(context.deploymentId);
    const archive = resolveArtifactPath(deps.dataDir, context.storageKey);
    const root = path.join(path.resolve(deps.dataDir), "build");
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const scratch = await fs.mkdtemp(path.join(root, "b-"));
    try {
        await extractSite(archive, path.join(scratch, "site"), deps.limits);
        await fs.writeFile(path.join(scratch, "Dockerfile"), dockerfile(deps.baseImage));
        await fs.writeFile(
            path.join(scratch, "nginx.conf"),
            nginxConf({ spa: context.spa, deploymentId: context.deploymentId }),
        );
        await deps.docker.build(scratch, tag, signal);
        return { imageTag: tag };
    } finally {
        await fs.rm(scratch, { recursive: true, force: true });
    }
}
