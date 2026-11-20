import { DokkuError } from "@launchpad-kit/dokku";
import { describe, expect, it, vi } from "vitest";
import { DeploymentEffectNotStarted } from "./deployment-errors";
import {
    runDeployment,
    type DeploymentRunnerPorts,
    type DeploymentStepStore,
} from "./deployment-runner";

const context = {
    deploymentId: "4cd063e8-2780-4e7b-a988-d31eecdc6572",
    appName: "lp-a123456789",
    hostname: "demo-a123456789.sites.example.net",
    spa: false,
    storageKey: "fixture",
};
const image = { imageTag: "fixture-tag", imageId: `sha256:${"a".repeat(64)}` };

function fixture() {
    const calls: string[] = [];
    const shutdown = new AbortController();
    const store = {
        begin: vi.fn(async (step) => {
            calls.push(`begin:${step}`);
            return true as true | null;
        }),
        complete: vi.fn(async (completion) => {
            calls.push(`complete:${completion.step}`);
            return true as true | null;
        }),
        stop: vi.fn(async () => true),
        // Wall-clock result is deliberately unrelated to the worker's clock.
        renew: vi.fn(async () => new Date(0) as Date | null),
    } satisfies DeploymentStepStore;
    const ports = {
        exists: vi.fn(async () => {
            calls.push("exists");
            return false;
        }),
        create: vi.fn(async () => {
            calls.push("create");
        }),
        build: vi.fn(async () => {
            calls.push("build");
            return image;
        }),
        setDomain: vi.fn(async () => {
            calls.push("domain");
        }),
        setPort: vi.fn(async () => {
            calls.push("port");
        }),
        load: vi.fn(async () => {
            calls.push("load");
        }),
        verify: vi.fn(async () => {
            calls.push("verify");
        }),
    } satisfies DeploymentRunnerPorts;
    return { store, ports, calls, shutdown };
}

describe("deployment runner", () => {
    it("persists intent before each effect and records the image before loading it", async () => {
        const { calls, store, ports, shutdown } = fixture();
        expect(
            await runDeployment(
                context,
                { stepDone: null, image: null },
                store,
                ports,
                shutdown.signal,
            ),
        ).toBe("succeeded");
        expect(calls).toEqual([
            "begin:app",
            "exists",
            "create",
            "complete:app",
            "begin:build",
            "build",
            "complete:build",
            "begin:configure",
            "domain",
            "port",
            "complete:configure",
            "begin:load",
            "load",
            "complete:load",
            "begin:verify",
            "verify",
            "complete:verify",
        ]);
        expect(store.complete).toHaveBeenCalledWith({ step: "build", ...image });
        expect(ports.create).toHaveBeenCalledWith(context.appName, expect.any(AbortSignal));
        expect(ports.load).toHaveBeenCalledWith(context, image, expect.any(AbortSignal));
    });

    it("never adopts or changes an app that already exists at creation", async () => {
        const { store, ports, shutdown } = fixture();
        ports.exists.mockResolvedValueOnce(true);
        expect(
            await runDeployment(
                context,
                { stepDone: null, image: null },
                store,
                ports,
                shutdown.signal,
            ),
        ).toBe("failed");
        expect(store.stop).toHaveBeenCalledWith("app", "failed");
        expect(ports.create).not.toHaveBeenCalled();
        expect(ports.build).not.toHaveBeenCalled();
    });

    it("resumes after a recorded step and retains an uncertain load for reconciliation", async () => {
        const { store, ports, shutdown } = fixture();
        ports.load.mockRejectedValueOnce(new Error("lost reply"));
        expect(
            await runDeployment(
                context,
                { stepDone: "configure", image },
                store,
                ports,
                shutdown.signal,
            ),
        ).toBe("reconciliation-needed");
        expect(store.stop).toHaveBeenCalledWith("load", "reconciliation-needed");
        expect(ports.exists).not.toHaveBeenCalled();
        expect(ports.build).not.toHaveBeenCalled();
        expect(ports.verify).not.toHaveBeenCalled();
    });

    it("holds a load when its own deadline aborts, without changing a sibling", async () => {
        const { store, ports, shutdown } = fixture();
        const effect = new AbortController();
        const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(effect.signal);
        const sibling = {
            ...context,
            appName: "lp-b123456789",
            hostname: "other.sites.example.net",
        };
        const routing = new Map([[sibling.appName, sibling.hostname]]);
        const load = vi.fn<DeploymentRunnerPorts["load"]>(async (target) => {
            routing.set(target.appName, target.hostname);
            effect.abort();
            throw new Error("No load confirmation");
        });
        try {
            expect(
                await runDeployment(
                    context,
                    { stepDone: "configure", image },
                    store,
                    { ...ports, load },
                    shutdown.signal,
                ),
            ).toBe("reconciliation-needed");
            expect(store.stop).toHaveBeenCalledWith("load", "reconciliation-needed");
            expect(store.complete).not.toHaveBeenCalled();
            expect(ports.verify).not.toHaveBeenCalled();
            expect(routing.get(sibling.appName)).toBe(sibling.hostname);
        } finally {
            timeout.mockRestore();
        }
    });

    it.each([
        ["app", "build", new DeploymentEffectNotStarted("Invalid archive")],
        [
            "configure",
            "load",
            new DokkuError({ kind: "not-started", operation: "load", message: "No session" }),
        ],
        ["load", "verify", new Error("Readiness probe failed")],
    ] as const)(
        "ends a definite %s failure without reconciliation",
        async (stepDone, step, error) => {
            const { store, ports, shutdown } = fixture();
            ports[step].mockRejectedValueOnce(error);
            expect(
                await runDeployment(context, { stepDone, image }, store, ports, shutdown.signal),
            ).toBe("failed");
            expect(store.stop).toHaveBeenCalledWith(step, "failed");
            expect(store.complete).not.toHaveBeenCalled();
        },
    );

    it("stops dispatch if the recovery gate closes after an earlier effect", async () => {
        const { store, ports, shutdown } = fixture();
        store.renew
            .mockResolvedValueOnce(new Date())
            .mockRejectedValueOnce(new Error("gate closed"));
        expect(
            await runDeployment(
                context,
                { stepDone: "build", image },
                store,
                ports,
                shutdown.signal,
            ),
        ).toBe("authority-lost");
        expect(ports.setDomain).toHaveBeenCalledOnce();
        expect(ports.setPort).not.toHaveBeenCalled();
        expect(store.complete).not.toHaveBeenCalled();
        expect(store.stop).not.toHaveBeenCalled();
    });

    it("does not dispatch another effect when an actual completion is refused", async () => {
        const { store, ports, shutdown } = fixture();
        store.complete.mockResolvedValueOnce(null);
        expect(
            await runDeployment(
                context,
                { stepDone: "load", image },
                store,
                ports,
                shutdown.signal,
            ),
        ).toBe("authority-lost");
        expect(ports.verify).toHaveBeenCalledOnce();
        expect(store.complete).toHaveBeenCalledWith({ step: "verify" });
        expect(store.stop).not.toHaveBeenCalled();
    });

    it("aborts an in-flight command when the heartbeat loses the lease", async () => {
        const { store, ports, shutdown } = fixture();
        store.renew.mockResolvedValueOnce(new Date()).mockResolvedValue(null);
        const load = vi.fn<DeploymentRunnerPorts["load"]>(async (_context, _image, signal) => {
            if (!signal.aborted) {
                await new Promise<void>((resolve) =>
                    signal.addEventListener("abort", () => resolve(), { once: true }),
                );
            }
            signal.throwIfAborted();
        });
        expect(
            await runDeployment(
                context,
                { stepDone: "configure", image },
                store,
                { ...ports, load },
                shutdown.signal,
            ),
        ).toBe("authority-lost");
        expect(load).toHaveBeenCalledOnce();
        expect(store.renew).toHaveBeenCalledTimes(2);
        expect(store.complete).not.toHaveBeenCalled();
        expect(ports.verify).not.toHaveBeenCalled();
    });

    it("cancels an in-flight effect on shutdown, leaving intent for reclaim", async () => {
        const { store, ports, shutdown } = fixture();
        const load = vi.fn<DeploymentRunnerPorts["load"]>(async (_context, _image, signal) => {
            const aborted = new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), { once: true }),
            );
            shutdown.abort();
            await aborted;
            signal.throwIfAborted();
        });
        expect(
            await runDeployment(
                context,
                { stepDone: "configure", image },
                store,
                { ...ports, load },
                shutdown.signal,
            ),
        ).toBe("authority-lost");
        expect(load).toHaveBeenCalledOnce();
        expect(store.complete).not.toHaveBeenCalled();
        expect(store.stop).not.toHaveBeenCalled();
        expect(ports.verify).not.toHaveBeenCalled();
    });

    it("records a confirmed result during shutdown but does not dispatch the next step", async () => {
        const { store, ports, shutdown } = fixture();
        ports.load.mockImplementationOnce(async () => shutdown.abort());
        expect(
            await runDeployment(
                context,
                { stepDone: "configure", image },
                store,
                ports,
                shutdown.signal,
            ),
        ).toBe("authority-lost");
        expect(store.complete).toHaveBeenCalledWith({ step: "load" });
        expect(ports.verify).not.toHaveBeenCalled();
    });
});
