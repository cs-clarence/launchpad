import { setTimeout as delay } from "node:timers/promises";
import { RouterControlError } from "@launchpad-kit/alias-router/control-client";
import type { PromotionReadback } from "@launchpad-kit/services";
import { AuthorityLost, createLeaseGuard } from "./lease-guard";

type Step = "dispatch" | "verify";
type Authority = { instanceId: string; epoch: string };
type Route = { hostname: string; aliasId: string; generation: string; operationId: string };
type Target = { deploymentId: string; hostname: string };

export interface PromotionContext {
    aliasId: string;
    aliasHostname: string;
    operationId: string;
    generation: string;
    // A corrective operation extends a chain of held operations. It is never failed outright.
    corrective: boolean;
    // Which claim of this operation this is (1 for the first).
    attempt: number;
    target: Target | null;
}

export interface PromotionStepStore {
    begin(step: Step): Promise<unknown | null>;
    acknowledge(): Promise<unknown | null>;
    hold(): Promise<unknown | null>;
    fail(code: string, message: string): Promise<unknown | null>;
    // Runs `verify` inside the commit transaction, after the shared recovery lock is held.
    finalize(
        authority: Authority,
        verify: (signal: AbortSignal) => Promise<PromotionReadback>,
    ): Promise<unknown | null>;
    renew(): Promise<Date | null>;
}

export interface PromotionRouterSession {
    authority: Authority;
    register(target: Target, signal: AbortSignal): Promise<unknown>;
    replaceRoute(
        write: Route & { targetDeploymentId: string | null },
        signal: AbortSignal,
    ): Promise<unknown>;
    observe(hostname: string, signal: AbortSignal): Promise<PromotionReadback>;
}

export interface PromotionRunnerPorts {
    // Reads credentials fresh for each run, so an operator's rotation takes effect without a restart.
    open(): PromotionRouterSession;
    // Whether the alias hostname serves the target (a bound alias), or the fixed 404 (withdrawn).
    serves(hostname: string, target: Target | null, signal: AbortSignal): Promise<boolean>;
}

export type PromotionRetryReason =
    | "credentials-unavailable"
    | "registration-refused"
    | "registration-unconfirmed";

export type PromotionOutcome =
    | "succeeded"
    | "failed"
    | "retry"
    | "reconciliation-needed"
    | "authority-lost";

// Each readback and probe happens inside a database transaction, whose connection may idle for at
// most its session limit; the budget covers repeated attempts and stays inside the lease.
// Failures before any route write is recorded are retried by the next claim; after this many
// claims an original operation fails and a corrective one is held for the operator.
export const MAX_PREDISPATCH_ATTEMPTS = 3;
const VERIFY_STEP_MS = 4000;
const VERIFY_BUDGET_MS = 45_000;
const VERIFY_PAUSE_MS = 2000;

class NotYetServing extends Error {}

export async function runPromotion(
    context: PromotionContext,
    resume: { stepDone: Step | null },
    store: PromotionStepStore,
    ports: PromotionRunnerPorts,
    shutdown: AbortSignal,
    options: {
        budgetMs?: number;
        pauseMs?: number;
        // A fixed reason code (never an error message) for each outcome that is not final.
        report?: (reason: PromotionRetryReason) => void;
    } = {},
): Promise<PromotionOutcome> {
    const timing = {
        budgetMs: options.budgetMs ?? VERIFY_BUDGET_MS,
        pauseMs: options.pauseMs ?? VERIFY_PAUSE_MS,
    };
    const guard = createLeaseGuard(() => store.renew(), shutdown);
    const { signal, dispatch } = guard;

    const hold = async (): Promise<PromotionOutcome> =>
        (await store.hold()) ? "reconciliation-needed" : "authority-lost";
    const refuse = async (): Promise<PromotionOutcome> =>
        (await store.fail("router-refused", "The router refused the alias route request."))
            ? "failed"
            : "authority-lost";
    const refused = (error: unknown) =>
        error instanceof RouterControlError && error.kind === "rejected";
    // Nothing about the route was sent: try again on the next claim, and once the attempts are
    // spent end it, so the alias and its pins are never stuck behind a permanent setup fault.
    const beforeDispatch = async (reason: PromotionRetryReason): Promise<PromotionOutcome> => {
        options.report?.(reason);
        if (context.attempt < MAX_PREDISPATCH_ATTEMPTS) return "retry";
        // A route write already acknowledged cannot be failed, and a chain's tip must stay: both
        // are held so the operator can reconcile them.
        if (context.corrective || resume.stepDone === "dispatch") return hold();
        return (await store.fail(
            "router-unavailable",
            "The router could not be reached to register the deployment.",
        ))
            ? "failed"
            : "authority-lost";
    };

    try {
        let session: PromotionRouterSession;
        try {
            session = ports.open();
        } catch {
            return beforeDispatch("credentials-unavailable");
        }

        if (resume.stepDone === null) {
            // Registering a deployment is idempotent and says nothing about the route, so a
            // failure here is retried later and a refusal fails the operation outright.
            if (context.target) {
                const { target } = context;
                try {
                    await dispatch((effect) => session.register(target, effect));
                } catch (error) {
                    if (error instanceof AuthorityLost || signal.aborted) return "authority-lost";
                    return beforeDispatch(
                        refused(error) ? "registration-refused" : "registration-unconfirmed",
                    );
                }
            }
            if (signal.aborted || !(await store.begin("dispatch"))) return "authority-lost";
            try {
                await dispatch((effect) =>
                    session.replaceRoute(
                        {
                            hostname: context.aliasHostname,
                            aliasId: context.aliasId,
                            operationId: context.operationId,
                            generation: context.generation,
                            targetDeploymentId: context.target?.deploymentId ?? null,
                        },
                        effect,
                    ),
                );
            } catch (error) {
                if (error instanceof AuthorityLost || signal.aborted) return "authority-lost";
                // A refusal of the only request sent proves nothing applied. After anything else
                // (a lost reply, a deadline, a conflict) the route may have changed: hold it.
                if (refused(error) && !context.corrective) return refuse();
                return hold();
            }
            if (!(await store.acknowledge())) return "authority-lost";
        }

        if (signal.aborted || !(await store.begin("verify"))) return "authority-lost";
        const deadline = performance.now() + timing.budgetMs;
        for (;;) {
            try {
                const committed = await dispatch((effect) =>
                    store.finalize(session.authority, async (bounded) => {
                        const attempt = AbortSignal.any([
                            effect,
                            bounded,
                            AbortSignal.timeout(VERIFY_STEP_MS),
                        ]);
                        // Probe first so the readback that is committed is the freshest evidence.
                        if (!(await ports.serves(context.aliasHostname, context.target, attempt))) {
                            throw new NotYetServing();
                        }
                        return session.observe(context.aliasHostname, attempt);
                    }),
                );
                // Null covers a lost fence, a readback that does not match, or an ineligible
                // target. None can be told apart, and none may release a pin: hold it.
                return committed ? "succeeded" : await hold();
            } catch (error) {
                if (error instanceof AuthorityLost || signal.aborted) return "authority-lost";
                if (performance.now() + timing.pauseMs >= deadline) return hold();
                await delay(timing.pauseMs, undefined, { signal }).catch(() => undefined);
                if (signal.aborted) return "authority-lost";
            }
        }
    } finally {
        await guard.close();
    }
}
