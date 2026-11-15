import type { ArchiveLimits, DeployPorts } from "@launchpad/services";
import type { DokkuClient } from "@launchpad/dokku";
import { buildImage } from "./build";
import type { Docker } from "./docker";
import { probe, type ProbeConfig } from "./verify";

export interface PortsDeps {
    dokku: DokkuClient;
    docker: Docker;
    dataDir: string;
    limits: ArchiveLimits;
    baseImage: string;
    probe: ProbeConfig;
}

// The real ports the state machine runs against. The state machine decides when;
// this decides how.
export function createDeployPorts(deps: PortsDeps): DeployPorts {
    return {
        dokku: deps.dokku,
        build: (context, signal) =>
            buildImage(
                context,
                {
                    dataDir: deps.dataDir,
                    limits: deps.limits,
                    docker: deps.docker,
                    baseImage: deps.baseImage,
                },
                signal,
            ),
        async loadImage(context, imageTag, signal) {
            const saved = deps.docker.save(imageTag, signal);
            try {
                const [loaded, finished] = await Promise.allSettled([
                    deps.dokku.git.loadImage(context.appName, imageTag, saved.stream, signal),
                    saved.done,
                ]);
                // Dokku's own answer comes first; a failed `docker save` after a clean
                // load is still an error, because the archive was truncated.
                if (loaded.status === "rejected") throw loaded.reason;
                if (finished.status === "rejected") throw finished.reason;
            } finally {
                await deps.docker.remove(imageTag);
            }
        },
        verify: (context, signal) =>
            probe(
                { hostname: context.hostname, deploymentId: context.deploymentId },
                deps.probe,
                signal,
            ),
    };
}
