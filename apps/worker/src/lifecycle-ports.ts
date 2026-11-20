import type { DokkuClient } from "@launchpad-kit/dokku";
import type { DeletionRunnerPorts } from "./deletion-runner";
import type { Docker } from "./docker";

export interface LifecyclePortsDeps {
    dokku: DokkuClient;
    docker: Docker;
}

// The real ports of a deletion. Nothing here lists, prunes or removes anything else, and the
// Dokku client itself refuses any app name that is not of the pattern it was built with (the
// generated `lp-` names in production).
export function createLifecyclePorts(deps: LifecyclePortsDeps): DeletionRunnerPorts {
    return {
        exists: (app, signal) => deps.dokku.apps.exists(app, signal),
        destroy: (app, signal) => deps.dokku.apps.destroy(app, signal),
        removeImage: async (tag, signal) => {
            signal.throwIfAborted();
            await deps.docker.removeImage(tag, signal);
        },
    };
}
