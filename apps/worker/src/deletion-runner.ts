import { DokkuError } from "@launchpad-kit/dokku";
import { AuthorityLost, createLeaseGuard } from "./lease-guard";

type Step = "destroy" | "images";
type Outcome = "retry" | "reconciliation-needed";

export interface DeletionStepStore {
    begin(step: Step): Promise<unknown | null>;
    complete(step: Step): Promise<unknown | null>;
    stop(step: Step, outcome: Outcome): Promise<unknown | null>;
    renew(): Promise<Date | null>;
}

// The vocabulary is exactly: does this app exist, destroy this app, remove this image tag.
export interface DeletionRunnerPorts {
    exists(app: string, signal: AbortSignal): Promise<boolean>;
    destroy(app: string, signal: AbortSignal): Promise<void>;
    removeImage(tag: string, signal: AbortSignal): Promise<void>;
}

export interface DeletionContext {
    appName: string;
    imageTag: string;
    // False when the app name was never created by this deployment: it is not ours to destroy.
    ownsRemoteApp: boolean;
}

function neverSent(error: unknown) {
    return (
        error instanceof DokkuError &&
        ["invalid-argument", "trust", "not-started"].includes(error.kind)
    );
}

export async function runDeletion(
    context: DeletionContext,
    resume: { stepDone: Step | null },
    store: DeletionStepStore,
    ports: DeletionRunnerPorts,
    shutdown: AbortSignal,
): Promise<"succeeded" | Outcome | "authority-lost"> {
    const guard = createLeaseGuard(() => store.renew(), shutdown);
    const { signal, dispatch } = guard;

    // A step that did not reach a remote effect is retried after a delay. One that may have is
    // held: an observed absence after a destroy is the only proof it finished.
    async function stop(step: Step, outcome: Outcome) {
        return (await store.stop(step, outcome)) ? outcome : "authority-lost";
    }

    try {
        if (resume.stepDone === null) {
            let present = false;
            if (context.ownsRemoteApp) {
                try {
                    present = await dispatch((effect) => ports.exists(context.appName, effect));
                } catch (error) {
                    if (error instanceof AuthorityLost || signal.aborted) return "authority-lost";
                    return stop("destroy", "retry");
                }
            }
            if (present) {
                if (signal.aborted || !(await store.begin("destroy"))) return "authority-lost";
                try {
                    await dispatch((effect) => ports.destroy(context.appName, effect));
                } catch (error) {
                    if (error instanceof AuthorityLost || signal.aborted) return "authority-lost";
                    return stop("destroy", neverSent(error) ? "retry" : "reconciliation-needed");
                }
                // The destroy was sent, so nothing short of an observed absence settles it.
                try {
                    if (await dispatch((effect) => ports.exists(context.appName, effect))) {
                        return stop("destroy", "reconciliation-needed");
                    }
                } catch (error) {
                    if (error instanceof AuthorityLost || signal.aborted) return "authority-lost";
                    return stop("destroy", "reconciliation-needed");
                }
            } else if (signal.aborted || !(await store.begin("destroy"))) {
                return "authority-lost";
            }
            if (!(await store.complete("destroy"))) return "authority-lost";
        }

        if (signal.aborted || !(await store.begin("images"))) return "authority-lost";
        try {
            await dispatch((effect) => ports.removeImage(context.imageTag, effect));
        } catch (error) {
            if (error instanceof AuthorityLost || signal.aborted) return "authority-lost";
            // Removing an exact local tag can be repeated, so a failure only waits and retries.
            return stop("images", "retry");
        }
        return (await store.complete("images")) ? "succeeded" : "authority-lost";
    } finally {
        await guard.close();
    }
}
