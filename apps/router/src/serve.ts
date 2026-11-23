import {
    createControlHandler,
    createDataHandler,
    createHttpUpstream,
    openRouterState,
    type RouterHostConfig,
} from "@launchpad-kit/alias-router";
import { acquireProcessLock } from "./lock";
import { readFileSync } from "node:fs";
import { readOwnerFile } from "./secret";

// Limits Bun.serve lets us set. It exposes neither a header-size limit, a header-read timeout nor a
// connection cap, so those stay Bun's defaults; an operator's firewall or front proxy covers them
// (recorded in the README and the plan).
const CONTROL_IDLE_SECONDS = 10;
const DATA_IDLE_SECONDS = 30;
const CONTROL_MAX_BODY_BYTES = 16 * 1024;
const DATA_MAX_BODY_BYTES = 1024; // GET, HEAD and OPTIONS only: no request body is ever used
export const DRAIN_MS = 10_000;

export interface RunningRouter {
    control: { host: string; port: number };
    data: { host: string; port: number };
    shutdown(): Promise<void>;
}

// Listen ports may be 0 (an ephemeral port) here, for tests; the settings parser never allows it.
export function startRouter(
    config: Pick<
        RouterHostConfig,
        | "stateFile"
        | "instanceId"
        | "appsDomain"
        | "control"
        | "data"
        | "upstreamOrigin"
        | "upstreamCaFile"
        | "controlTls"
    >,
): RunningRouter {
    const lock = acquireProcessLock(config.stateFile);
    const closers: (() => void)[] = [() => lock.release()];
    const unwind = () => {
        for (const close of closers.reverse()) {
            try {
                close();
            } catch {
                // Keep releasing the rest.
            }
        }
    };
    try {
        const store = openRouterState(config.stateFile, {
            instanceId: config.instanceId,
            appsDomain: config.appsDomain,
        });
        closers.push(() => store.close());
        const upstream = createHttpUpstream({
            origin: config.upstreamOrigin,
            ...(config.upstreamCaFile ? { caFile: config.upstreamCaFile } : {}),
        });
        const control = createControlHandler(store);
        const data = createDataHandler(store, { upstream });
        const fixed = () => new Response("Internal error\n", { status: 500 });
        const controlServer = Bun.serve({
            ...(config.controlTls
                ? {
                      tls: {
                          cert: readFileSync(config.controlTls.certFile),
                          key: readOwnerFile(config.controlTls.keyFile, 64 * 1024),
                      },
                  }
                : {}),
            hostname: config.control.host,
            port: config.control.port,
            idleTimeout: CONTROL_IDLE_SECONDS,
            maxRequestBodySize: CONTROL_MAX_BODY_BYTES,
            fetch: (request) => control(request),
            error: fixed,
        });
        closers.push(() => void controlServer.stop(true));
        const dataServer = Bun.serve({
            hostname: config.data.host,
            port: config.data.port,
            idleTimeout: DATA_IDLE_SECONDS,
            maxRequestBodySize: DATA_MAX_BODY_BYTES,
            fetch: (request) => data(request),
            error: fixed,
        });
        closers.push(() => void dataServer.stop(true));

        let stopping: Promise<void> | undefined;
        return {
            control: { host: config.control.host, port: controlServer.port ?? config.control.port },
            data: { host: config.data.host, port: dataServer.port ?? config.data.port },
            // Stop accepting, drain in-flight requests with a deadline, abort what remains, close the
            // store, then release the lock (the reverse of how they were taken).
            shutdown() {
                stopping ??= (async () => {
                    // A rejected stop must not become an unhandled rejection after the deadline wins.
                    const drained = Promise.all([
                        controlServer.stop(false),
                        dataServer.stop(false),
                    ]).catch(() => undefined);
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    const deadline = new Promise<void>((resolve) => {
                        timer = setTimeout(resolve, DRAIN_MS);
                    });
                    await Promise.race([drained, deadline]);
                    clearTimeout(timer);
                    unwind();
                })();
                return stopping;
            },
        };
    } catch (error) {
        unwind();
        throw error;
    }
}
