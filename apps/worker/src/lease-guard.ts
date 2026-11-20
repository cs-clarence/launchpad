import { setTimeout as delay } from "node:timers/promises";
import { DEPLOYMENT_LEASE_MS } from "@launchpad-kit/services";
import { withinDeadline } from "./deadline";

export class AuthorityLost extends Error {}

// Bound work by the lease issued on the database clock, without comparing its
// timestamp to the worker's wall clock. Time spent acquiring the lease counts
// against the budget. Leave room for local subprocess termination and writeback.
const LEASE_MARGIN_MS = 10_000;
const HEARTBEAT_MS = 2000;
const RENEW_TIMEOUT_MS = 10_000;

// Renewal also checks the recovery gate. An in-flight command has its own lease-bounded
// deadline even if a database heartbeat stalls. `dispatch` renews first, so no effect starts
// without current authority, and bounds the effect inside the lease it just obtained.
export function createLeaseGuard(renewLease: () => Promise<Date | null>, shutdown: AbortSignal) {
    const stop = new AbortController();
    const signal = AbortSignal.any([shutdown, stop.signal]);
    let permittedUntil = 0;

    async function renew() {
        signal.throwIfAborted();
        const requestedAt = performance.now();
        try {
            if ((await withinDeadline(renewLease, RENEW_TIMEOUT_MS, signal)) === null) {
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

    return {
        signal,
        async dispatch<T>(call: (effect: AbortSignal) => Promise<T>): Promise<T> {
            await renew();
            const remaining = Math.floor(permittedUntil - performance.now());
            if (remaining <= 0) throw new AuthorityLost();
            const effect = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
            effect.throwIfAborted();
            return call(effect);
        },
        async close() {
            stop.abort();
            await heartbeat;
        },
    };
}
