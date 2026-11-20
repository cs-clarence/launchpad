import { setTimeout as delay } from "node:timers/promises";
import { DokkuError } from "@launchpad-kit/dokku";
import { DEPLOYMENT_LEASE_MS } from "@launchpad-kit/services";
import { withinDeadline } from "./deadline";
import { DeploymentEffectNotStarted } from "./deployment-errors";
import type { DeployContext } from "./types";

const steps = ["app", "build", "configure", "load", "verify"] as const;
type Step = (typeof steps)[number];
type Image = { imageTag: string; imageId: string };
type Completion = { step: Exclude<Step, "build"> } | ({ step: "build" } & Image);
type Failure = "failed" | "reconciliation-needed";

// Bound work by the lease issued on the database clock, without comparing its
// timestamp to the worker's wall clock. Time spent acquiring the lease counts
// against the budget. Leave room for local subprocess termination and writeback.
const LEASE_MARGIN_MS = 10_000;
const HEARTBEAT_MS = 2000;
const RENEW_TIMEOUT_MS = 10_000;

export interface DeploymentStepStore {
    begin(step: Step): Promise<unknown | null>;
    complete(completion: Completion): Promise<unknown | null>;
    stop(step: Step, outcome: Failure): Promise<unknown | null>;
    renew(): Promise<Date | null>;
}

// Only the current deployment is available here. In particular there is no
// rollback port, lookup for a sibling, or generic command execution.
export interface DeploymentRunnerPorts {
    exists(app: string, signal: AbortSignal): Promise<boolean>;
    create(app: string, signal: AbortSignal): Promise<void>;
    build(context: DeployContext, signal: AbortSignal): Promise<Image>;
    setDomain(app: string, hostname: string, signal: AbortSignal): Promise<void>;
    setPort(app: string, signal: AbortSignal): Promise<void>;
    load(context: DeployContext, image: Image, signal: AbortSignal): Promise<void>;
    verify(context: DeployContext, signal: AbortSignal): Promise<void>;
}

class AuthorityLost extends Error {}
function definitelyStopped(error: unknown) {
    return (
        error instanceof DeploymentEffectNotStarted ||
        (error instanceof DokkuError &&
            ["invalid-argument", "trust", "not-started"].includes(error.kind))
    );
}

export async function runDeployment(
    context: DeployContext,
    resume: { stepDone: Step | null; image: Image | null },
    store: DeploymentStepStore,
    ports: DeploymentRunnerPorts,
    shutdown: AbortSignal,
): Promise<"succeeded" | Failure | "authority-lost"> {
    const stop = new AbortController();
    const signal = AbortSignal.any([shutdown, stop.signal]);
    let permittedUntil = 0;

    async function renew() {
        signal.throwIfAborted();
        const requestedAt = performance.now();
        try {
            if ((await withinDeadline(() => store.renew(), RENEW_TIMEOUT_MS, signal)) === null) {
                throw new AuthorityLost();
            }
        } catch {
            stop.abort(new AuthorityLost());
            throw new AuthorityLost();
        }
        const until = requestedAt + DEPLOYMENT_LEASE_MS - LEASE_MARGIN_MS;
        if (performance.now() >= until) {
            stop.abort(new AuthorityLost());
            throw new AuthorityLost();
        }
        permittedUntil = Math.max(permittedUntil, until);
        signal.throwIfAborted();
    }

    // Renewal also checks the recovery gate. An in-flight command has its own
    // lease-bounded deadline even if a database heartbeat stalls.
    const heartbeat = (async () => {
        try {
            while (!signal.aborted) {
                await delay(HEARTBEAT_MS, undefined, { signal });
                await renew();
            }
        } catch {
            stop.abort(new AuthorityLost());
        }
    })();

    async function dispatch<T>(call: (effect: AbortSignal) => Promise<T>): Promise<T> {
        await renew();
        const remaining = Math.floor(permittedUntil - performance.now());
        if (remaining <= 0) throw new AuthorityLost();
        const effect = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
        effect.throwIfAborted();
        return call(effect);
    }

    async function appExists() {
        return dispatch(async (effect) => {
            try {
                return await ports.exists(context.appName, effect);
            } catch (cause) {
                // A failed read cannot leave an ambiguous create behind.
                throw new DeploymentEffectNotStarted("Could not check the app name.", { cause });
            }
        });
    }

    try {
        let image = resume.image;
        const remaining = steps.slice(
            resume.stepDone === null ? 0 : steps.indexOf(resume.stepDone) + 1,
        );
        if (!remaining.length) return "authority-lost";
        for (const step of remaining) {
            if (signal.aborted || !(await store.begin(step))) return "authority-lost";
            let completion: Completion;
            try {
                switch (step) {
                    case "app":
                        if (await appExists()) {
                            throw new DeploymentEffectNotStarted("The app name already exists.");
                        }
                        await dispatch((effect) => ports.create(context.appName, effect));
                        completion = { step };
                        break;
                    case "build":
                        image = await dispatch((effect) => ports.build(context, effect));
                        completion = { step, ...image };
                        break;
                    case "configure":
                        await dispatch((effect) =>
                            ports.setDomain(context.appName, context.hostname, effect),
                        );
                        await dispatch((effect) => ports.setPort(context.appName, effect));
                        completion = { step };
                        break;
                    case "load": {
                        const built = image;
                        if (!built)
                            throw new DeploymentEffectNotStarted(
                                "The deployment has no recorded image.",
                            );
                        await dispatch((effect) => ports.load(context, built, effect));
                        completion = { step };
                        break;
                    }
                    case "verify":
                        await dispatch((effect) => ports.verify(context, effect));
                        completion = { step };
                        break;
                }
            } catch (error) {
                if (error instanceof AuthorityLost || signal.aborted) return "authority-lost";
                // The probe is read-only. For effects, a generic adapter error
                // does not prove that the engine stopped, even if its client did.
                const outcome =
                    step === "verify" || definitelyStopped(error)
                        ? "failed"
                        : "reconciliation-needed";
                return (await store.stop(step, outcome)) ? outcome : "authority-lost";
            }
            // A confirmed result may still be written after shutdown if the
            // gate and fence allow it. The next iteration cannot dispatch.
            if (!(await store.complete(completion))) return "authority-lost";
        }
        return "succeeded";
    } finally {
        stop.abort();
        await heartbeat;
    }
}
