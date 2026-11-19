import { randomUUID } from "node:crypto";
import {
    initializeRouterState,
    openRouterState,
    type RouterHostConfig,
} from "@launchpad-kit/alias-router";
import { acquireProcessLock } from "./lock";

// Operator commands act directly on the state file and need the same exclusive lock as `serve`:
// `rotate` therefore refuses to run while the router is up. They print only the new epoch, which is
// not a secret; the token is supplied by the operator and never returned.

type StateConfig = Pick<RouterHostConfig, "stateFile" | "instanceId" | "appsDomain">;

export function initRouter(config: StateConfig, token: string): string {
    const lock = acquireProcessLock(config.stateFile);
    try {
        const epoch = randomUUID();
        initializeRouterState(
            config.stateFile,
            { instanceId: config.instanceId, appsDomain: config.appsDomain },
            { epoch, token },
        );
        return epoch;
    } finally {
        lock.release();
    }
}

export function rotateRouter(config: StateConfig, token: string): string {
    const lock = acquireProcessLock(config.stateFile);
    try {
        const store = openRouterState(config.stateFile, {
            instanceId: config.instanceId,
            appsDomain: config.appsDomain,
        });
        try {
            return store.rotateAuthority({ epoch: randomUUID(), token }).epoch;
        } finally {
            store.close();
        }
    } finally {
        lock.release();
    }
}
