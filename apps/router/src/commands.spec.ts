import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openRouterState, RouterError } from "@launchpad-kit/alias-router";
import { initRouter, rotateRouter } from "./commands";
import { acquireProcessLock, LockError } from "./lock";
import { newToken, tempState, type TempState } from "./test-support";

let state: TempState;
afterEach(() => state?.cleanup());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const options = () => ({
    instanceId: state.config.instanceId,
    appsDomain: state.config.appsDomain,
});

describe("operator commands", () => {
    it("init creates state that authenticates with the printed epoch and the supplied token", () => {
        state = tempState();
        const token = newToken();
        const epoch = initRouter(state.config, token);
        expect(epoch).toMatch(UUID);
        const store = openRouterState(state.stateFile, options());
        try {
            store.authenticate({ instanceId: state.config.instanceId, epoch, token });
            expect(() =>
                store.authenticate({
                    instanceId: state.config.instanceId,
                    epoch,
                    token: newToken(),
                }),
            ).toThrow(RouterError);
        } finally {
            store.close();
        }
    });

    it("init never reinitializes existing state and releases the lock on failure", () => {
        state = tempState();
        initRouter(state.config, newToken());
        expect(() => initRouter(state.config, newToken())).toThrow(RouterError);
        acquireProcessLock(state.stateFile).release();
    });

    it("rotate starts a new epoch, fences the old pair, keeps routes, and refuses while the lock is held", () => {
        state = tempState();
        const first = newToken();
        const epoch = initRouter(state.config, first);
        const held = acquireProcessLock(state.stateFile);
        expect(() => rotateRouter(state.config, newToken())).toThrow(LockError);
        held.release();
        const second = newToken();
        const next = rotateRouter(state.config, second);
        expect(next).toMatch(UUID);
        expect(next).not.toBe(epoch);
        const store = openRouterState(state.stateFile, options());
        try {
            expect(() =>
                store.authenticate({ instanceId: state.config.instanceId, epoch, token: first }),
            ).toThrow(RouterError);
            store.authenticate({ instanceId: state.config.instanceId, epoch: next, token: second });
        } finally {
            store.close();
        }
        // A reused token or a wrong instance is refused and leaves the lock released.
        expect(() => rotateRouter(state.config, second)).toThrow(RouterError);
        expect(() =>
            rotateRouter({ ...state.config, instanceId: randomUUID() }, newToken()),
        ).toThrow(RouterError);
        acquireProcessLock(state.stateFile).release();
    });

    it("rotate refuses to create missing state", () => {
        state = tempState();
        expect(() => rotateRouter(state.config, newToken())).toThrow(RouterError);
    });
});
