import type { ArchiveLimits } from "@launchpad-kit/services";
import type { DokkuClient } from "@launchpad-kit/dokku";
import { buildImage } from "./build";
import { DeploymentEffectNotStarted } from "./deployment-errors";
import type { DeploymentRunnerPorts } from "./deployment-runner";
import type { Docker } from "./docker";
import { imageTagFor } from "./template";
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
export function createDeployPorts(deps: PortsDeps): DeploymentRunnerPorts {
    const build: DeploymentRunnerPorts["build"] = async (context, signal) => {
        const { imageTag } = await buildImage(
            context,
            {
                dataDir: deps.dataDir,
                limits: deps.limits,
                docker: deps.docker,
                baseImage: deps.baseImage,
            },
            signal,
        );
        return { imageTag, imageId: await deps.docker.imageId(imageTag, signal) };
    };
    const load: DeploymentRunnerPorts["load"] = async (context, { imageTag, imageId }, signal) => {
        try {
            if (
                imageTag !== imageTagFor(context.deploymentId) ||
                (await deps.docker.imageId(imageTag, signal)) !== imageId
            ) {
                throw new Error("Image identity did not match.");
            }
            signal.throwIfAborted();
        } catch (cause) {
            throw new DeploymentEffectNotStarted(
                "The deployment's recorded image is not available.",
                { cause },
            );
        }
        // `docker save` gets its own stop: if Dokku refuses before reading the stream
        // (trust, a refused argument, an already-cancelled call), nothing drains the pipe
        // and the save would otherwise block until the deadline.
        const stopSave = new AbortController();
        const saved = deps.docker.save(imageTag, AbortSignal.any([signal, stopSave.signal]));
        const loading = deps.dokku.git
            .loadImage(context.appName, imageTag, saved.stream, signal)
            .catch((error: unknown) => {
                stopSave.abort();
                throw error;
            });
        const [loaded, finished] = await Promise.allSettled([loading, saved.done]);
        // Keep the image until guarded deletion. Never remove it as a side
        // effect of a timed-out or unconfirmed load.
        if (loaded.status === "rejected") throw loaded.reason;
        if (finished.status === "rejected") throw finished.reason;
    };
    const verify: DeploymentRunnerPorts["verify"] = (context, signal) =>
        probe(
            { hostname: context.hostname, deploymentId: context.deploymentId },
            deps.probe,
            signal,
        );
    return {
        exists: deps.dokku.apps.exists,
        create: deps.dokku.apps.create,
        setDomain: deps.dokku.domains.set,
        setPort: (app, signal) => deps.dokku.ports.set(app, "http:80:80", signal),
        build,
        load,
        verify,
    };
}
