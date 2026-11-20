import { RouterControlError } from "@launchpad-kit/alias-router/control-client";
import { describe, expect, it, vi } from "vitest";
import {
    runPromotion,
    type PromotionContext,
    type PromotionRouterSession,
    type PromotionRunnerPorts,
    type PromotionStepStore,
} from "./promotion-runner";

const target = {
    deploymentId: "11111111-1111-4111-8111-111111111111",
    hostname: "d.sites.example.net",
};
const context: PromotionContext = {
    aliasId: "22222222-2222-4222-8222-222222222222",
    aliasHostname: "view.sites.example.net",
    operationId: "33333333-3333-4333-8333-333333333333",
    generation: "1",
    corrective: false,
    attempt: 1,
    target,
};
const authority = {
    instanceId: "44444444-4444-4444-8444-444444444444",
    epoch: "55555555-5555-4555-8555-555555555555",
};
const readback = {
    ...authority,
    route: {
        aliasId: context.aliasId,
        hostname: context.aliasHostname,
        operationId: context.operationId,
        generation: "1",
        target,
    },
};

function fixture() {
    const calls: string[] = [];
    const store = {
        begin: vi.fn(async (step) => (calls.push(`begin:${step}`), {} as unknown | null)),
        acknowledge: vi.fn(async () => (calls.push("ack"), {} as unknown | null)),
        hold: vi.fn(async () => (calls.push("hold"), {} as unknown | null)),
        fail: vi.fn(async () => (calls.push("fail"), {} as unknown | null)),
        finalize: vi.fn(async (_authority, verify) => {
            calls.push("finalize");
            await verify(new AbortController().signal);
            return {} as unknown | null;
        }),
        renew: vi.fn(async () => new Date(0) as Date | null),
    } satisfies PromotionStepStore;
    const ports = {
        open: vi.fn<PromotionRunnerPorts["open"]>((): PromotionRouterSession => ({
            authority,
            register: async () => void calls.push("register"),
            replaceRoute: async () => void calls.push("replace"),
            observe: async () => (calls.push("observe"), readback),
        })),
        serves: vi.fn<PromotionRunnerPorts["serves"]>(async () => (calls.push("serves"), true)),
    };
    return { calls, store, ports, shutdown: new AbortController() };
}
const run = (
    f: ReturnType<typeof fixture>,
    over: Partial<PromotionContext> = {},
    stepDone: "dispatch" | null = null,
) => runPromotion({ ...context, ...over }, { stepDone }, f.store, f.ports, f.shutdown.signal);
const refusal = () => new RouterControlError("rejected");

describe("promotion runner", () => {
    it("records intent before dispatch, then verifies and finalizes inside the commit", async () => {
        const f = fixture();
        expect(await run(f)).toBe("succeeded");
        expect(f.calls).toEqual([
            "register",
            "begin:dispatch",
            "replace",
            "ack",
            "begin:verify",
            "finalize",
            "serves",
            "observe",
        ]);
        expect(f.store.finalize).toHaveBeenCalledWith(authority, expect.any(Function));
    });

    it("withdraws without registering a target", async () => {
        const f = fixture();
        expect(await run(f, { target: null })).toBe("succeeded");
        expect(f.calls[0]).toBe("begin:dispatch");
        expect(f.ports.serves).toHaveBeenCalledWith(
            context.aliasHostname,
            null,
            expect.any(AbortSignal),
        );
    });

    it("resumes an acknowledged dispatch with read-only verification", async () => {
        const f = fixture();
        expect(await run(f, {}, "dispatch")).toBe("succeeded");
        expect(f.calls).not.toContain("replace");
        expect(f.calls).not.toContain("begin:dispatch");
    });

    it("fails a refused route write, but only for an original operation", async () => {
        const sent = fixture();
        sent.ports.open.mockReturnValueOnce({
            authority,
            register: async () => undefined,
            replaceRoute: async () => Promise.reject(refusal()),
            observe: async () => readback,
        });
        expect(await run(sent)).toBe("failed");

        const corrective = fixture();
        corrective.ports.open.mockReturnValueOnce({
            authority,
            register: async () => undefined,
            replaceRoute: async () => Promise.reject(refusal()),
            observe: async () => readback,
        });
        expect(await run(corrective, { corrective: true })).toBe("reconciliation-needed");
        expect(corrective.store.fail).not.toHaveBeenCalled();
    });

    it("holds anything uncertain after the dispatch was recorded", async () => {
        for (const kind of ["uncertain", "not-sent"] as const) {
            const f = fixture();
            f.ports.open.mockReturnValueOnce({
                authority,
                register: async () => undefined,
                replaceRoute: async () => Promise.reject(new RouterControlError(kind)),
                observe: async () => readback,
            });
            expect(await run(f)).toBe("reconciliation-needed");
            expect(f.calls).toContain("hold");
            expect(f.store.acknowledge).not.toHaveBeenCalled();
        }
    });

    it("retries before dispatch with a reason, then ends it once the attempts are spent", async () => {
        const down = (kind: "uncertain" | "rejected") => ({
            authority,
            register: async () => Promise.reject(new RouterControlError(kind)),
            replaceRoute: async () => undefined,
            observe: async () => readback,
        });
        const reasons: string[] = [];
        const report = (reason: string) => reasons.push(reason);
        const runWith = (f: ReturnType<typeof fixture>, over: Partial<PromotionContext>) =>
            runPromotion(
                { ...context, ...over },
                { stepDone: null },
                f.store,
                f.ports,
                f.shutdown.signal,
                {
                    report,
                },
            );

        const first = fixture();
        first.ports.open.mockReturnValueOnce(down("uncertain"));
        expect(await runWith(first, {})).toBe("retry");
        const refused = fixture();
        refused.ports.open.mockReturnValueOnce(down("rejected"));
        expect(await runWith(refused, {})).toBe("retry");
        const broken = fixture();
        broken.ports.open.mockImplementationOnce(() => {
            throw new Error("Could not read the configured router credential file.");
        });
        expect(await runWith(broken, {})).toBe("retry");
        expect(reasons).toEqual([
            "registration-unconfirmed",
            "registration-refused",
            "credentials-unavailable",
        ]);
        for (const f of [first, refused, broken]) expect(f.store.begin).not.toHaveBeenCalled();

        const spent = fixture();
        spent.ports.open.mockReturnValueOnce(down("uncertain"));
        expect(await runWith(spent, { attempt: 3 })).toBe("failed");
        expect(spent.store.fail).toHaveBeenCalledWith("router-unavailable", expect.any(String));

        const chain = fixture();
        chain.ports.open.mockReturnValueOnce(down("uncertain"));
        expect(await runWith(chain, { attempt: 3, corrective: true })).toBe(
            "reconciliation-needed",
        );
        expect(chain.store.fail).not.toHaveBeenCalled();
        expect(chain.store.hold).toHaveBeenCalled();
    });

    it("never commits when the intent write is refused, a stale worker gets authority-lost", async () => {
        const noIntent = fixture();
        noIntent.store.begin.mockResolvedValueOnce(null);
        expect(await run(noIntent)).toBe("authority-lost");
        expect(noIntent.calls).not.toContain("replace");

        // The fence moved on: finalization changes nothing and neither does the hold.
        const stale = fixture();
        stale.store.finalize.mockResolvedValue(null);
        stale.store.hold.mockResolvedValue(null);
        expect(await run(stale, {}, "dispatch")).toBe("authority-lost");

        // A readback that does not match is held, never finalized.
        const mismatch = fixture();
        mismatch.store.finalize.mockResolvedValue(null);
        expect(await run(mismatch, {}, "dispatch")).toBe("reconciliation-needed");
    });

    it("holds when the alias never serves the target within the budget", async () => {
        const f = fixture();
        f.ports.serves.mockResolvedValue(false);
        const outcome = await runPromotion(
            context,
            { stepDone: "dispatch" },
            f.store,
            f.ports,
            f.shutdown.signal,
            { budgetMs: 60, pauseMs: 10 },
        );
        expect(outcome).toBe("reconciliation-needed");
        expect(f.store.hold).toHaveBeenCalled();
        expect(f.store.finalize.mock.calls.length).toBeGreaterThan(1);
    });
});
