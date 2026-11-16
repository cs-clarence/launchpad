import type { DokkuClient } from "@launchpad/dokku";
import type { LifecyclePorts } from "@launchpad/services";
import type { Docker } from "./docker";

export interface LifecyclePortsDeps {
    dokku: DokkuClient;
    docker: Docker;
}

// The real ports of a deletion. The vocabulary is exactly this: ask whether one named app
// exists, destroy one named app, remove one image by its exact tag. Nothing here lists,
// prunes or removes anything else, and the Dokku client itself refuses any app name that
// is not of the pattern it was built with (the generated `lp-` names in production).
export function createLifecyclePorts(deps: LifecyclePortsDeps): LifecyclePorts {
    return {
        dokku: {
            apps: {
                exists: (app, signal) => deps.dokku.apps.exists(app, signal),
                destroy: (app, signal) => deps.dokku.apps.destroy(app, signal),
            },
        },
        async removeImages({ imageTags }, signal) {
            for (const tag of imageTags) {
                signal.throwIfAborted();
                await deps.docker.removeImage(tag, signal);
            }
        },
    };
}
