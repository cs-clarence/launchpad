import { DokkuError } from "@launchpad-kit/dokku";
import { describe, expect, it, vi } from "vitest";
import { runDeletion, type DeletionRunnerPorts, type DeletionStepStore } from "./deletion-runner";

const context = { appName: "lp-a123456789", imageTag: "launchpad/site:abc", ownsRemoteApp: true };

function fixture() {
    const calls: string[] = [];
    const shutdown = new AbortController();
    const store = {
        begin: vi.fn(async (step) => (calls.push(`begin:${step}`), true as true | null)),
        complete: vi.fn(async (step) => (calls.push(`complete:${step}`), true as true | null)),
        stop: vi.fn(async () => true as true | null),
        renew: vi.fn(async () => new Date(0) as Date | null),
    } satisfies DeletionStepStore;
    let present = true;
    const ports = {
        exists: vi.fn(async () => (calls.push(`exists:${present}`), present)),
        destroy: vi.fn(async () => {
            calls.push("destroy");
            present = false;
        }),
        removeImage: vi.fn(async () => void calls.push("rmi")),
    } satisfies DeletionRunnerPorts;
    return { store, ports, calls, shutdown, setPresent: (value: boolean) => (present = value) };
}
const run = (f: ReturnType<typeof fixture>, over = {}, stepDone: "destroy" | null = null) =>
    runDeletion({ ...context, ...over }, { stepDone }, f.store, f.ports, f.shutdown.signal);

describe("deletion runner", () => {
    it("reads, records intent, destroys, confirms absence, then removes the exact image", async () => {
        const f = fixture();
        expect(await run(f)).toBe("succeeded");
        expect(f.calls).toEqual([
            "exists:true",
            "begin:destroy",
            "destroy",
            "exists:false",
            "complete:destroy",
            "begin:images",
            "rmi",
            "complete:images",
        ]);
        expect(f.ports.destroy).toHaveBeenCalledWith(context.appName, expect.any(AbortSignal));
        expect(f.ports.removeImage).toHaveBeenCalledWith(context.imageTag, expect.any(AbortSignal));
    });

    it("treats an app that is absent after a read as done without destroying", async () => {
        const f = fixture();
        f.setPresent(false);
        expect(await run(f)).toBe("succeeded");
        expect(f.ports.destroy).not.toHaveBeenCalled();
    });

    it("never touches a name this deployment did not create", async () => {
        const f = fixture();
        expect(await run(f, { ownsRemoteApp: false })).toBe("succeeded");
        expect(f.ports.exists).not.toHaveBeenCalled();
        expect(f.ports.destroy).not.toHaveBeenCalled();
        expect(f.ports.removeImage).toHaveBeenCalledOnce();
    });

    it("retries a failed existence read, since nothing was sent", async () => {
        const f = fixture();
        f.ports.exists.mockRejectedValueOnce(new Error("timed out"));
        expect(await run(f)).toBe("retry");
        expect(f.store.stop).toHaveBeenCalledWith("destroy", "retry");
        expect(f.ports.destroy).not.toHaveBeenCalled();
    });

    it("retries a destroy refused before it was sent, but holds an uncertain one", async () => {
        const refused = fixture();
        refused.ports.destroy.mockRejectedValueOnce(
            new DokkuError({
                kind: "not-started",
                operation: "apps:destroy",
                message: "no session",
            }),
        );
        expect(await run(refused)).toBe("retry");
        const lost = fixture();
        lost.ports.destroy.mockRejectedValueOnce(
            new DokkuError({
                kind: "uncertain",
                operation: "apps:destroy",
                mutating: true,
                message: "lost",
            }),
        );
        expect(await run(lost)).toBe("reconciliation-needed");
        expect(lost.store.stop).toHaveBeenCalledWith("destroy", "reconciliation-needed");
        expect(lost.ports.removeImage).not.toHaveBeenCalled();
    });

    it("holds the deletion when the app is still present after a destroy", async () => {
        const f = fixture();
        f.ports.destroy.mockImplementationOnce(async () => void f.calls.push("destroy"));
        expect(await run(f)).toBe("reconciliation-needed");
        expect(f.store.complete).not.toHaveBeenCalled();
        expect(f.ports.removeImage).not.toHaveBeenCalled();
    });

    it("resumes at image removal after a recorded destroy and retries a failed removal", async () => {
        const f = fixture();
        f.ports.removeImage.mockRejectedValueOnce(new Error("busy"));
        expect(await run(f, {}, "destroy")).toBe("retry");
        expect(f.ports.exists).not.toHaveBeenCalled();
        expect(f.store.stop).toHaveBeenCalledWith("images", "retry");
    });

    it("stops dispatch without writing when authority is lost", async () => {
        const f = fixture();
        f.store.renew.mockResolvedValueOnce(new Date()).mockResolvedValue(null);
        expect(await run(f)).toBe("authority-lost");
        expect(f.ports.destroy).not.toHaveBeenCalled();
        expect(f.store.complete).not.toHaveBeenCalled();
        expect(f.store.stop).not.toHaveBeenCalled();
    });

    it("does not dispatch the next step when a completion is refused", async () => {
        const f = fixture();
        f.store.complete.mockResolvedValueOnce(null);
        expect(await run(f)).toBe("authority-lost");
        expect(f.ports.removeImage).not.toHaveBeenCalled();
    });
});
