import type { ArchiveLimits, DeployPorts } from "@launchpad-kit/services";
import type { DokkuClient } from "@launchpad-kit/dokku";
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
    const build: DeployPorts["build"] = (context, signal) =>
        buildImage(
            context,
            {
                dataDir: deps.dataDir,
                limits: deps.limits,
                docker: deps.docker,
                baseImage: deps.baseImage,
            },
            signal,
        );
    const loadImage: DeployPorts["loadImage"] = async (context, imageTag, signal) => {
        // `docker save` gets its own stop: if Dokku refuses before reading the stream
        // (trust, a refused argument, an already-cancelled call), nothing drains the pipe
        // and the save would otherwise block until the deadline.
        const stopSave = new AbortController();
        const saved = deps.docker.save(imageTag, AbortSignal.any([signal, stopSave.signal]));
        try {
            const loading = deps.dokku.git
                .loadImage(context.appName, imageTag, saved.stream, signal)
                .catch((error: unknown) => {
                    stopSave.abort();
                    throw error;
                });
            const [loaded, finished] = await Promise.allSettled([loading, saved.done]);
            // Dokku's own answer comes first; a failed `docker save` after a clean
            // load is still an error, because the archive was truncated.
            if (loaded.status === "rejected") throw loaded.reason;
            if (finished.status === "rejected") throw finished.reason;
        } finally {
            await deps.docker.remove(imageTag);
        }
    };
    const verify: DeployPorts["verify"] = (context, signal) =>
        probe(
            { hostname: context.hostname, deploymentId: context.deploymentId },
            deps.probe,
            signal,
        );
    return {
        dokku: deps.dokku,
        build,
        loadImage,
        verify,
        // The previous release is rebuilt from its own stored artifact with the same
        // fixed template, loaded, and probed for *its* id: restoring is the ordinary
        // path, not a special one, so there is no second way to change what is running.
        async rollback(_context, previous, signal) {
            const built = await build(previous, signal);
            await loadImage(previous, built.imageTag, signal);
            await verify(previous, signal);
        },
    };
}
