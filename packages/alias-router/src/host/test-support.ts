import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeRouterState, openRouterState, type RouterStore } from "../store";

export interface HostFixture {
    store: RouterStore;
    options: { instanceId: string; appsDomain: string };
    credentials: { instanceId: string; epoch: string; token: string };
    headers: Record<string, string>;
    cleanup: () => void;
}

// A real, private, temporary store: the same files and SQLite engine as production.
export function hostFixture(): HostFixture {
    const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "launchpad-router-host-"));
    chmodSync(directory, 0o700);
    const file = path.join(directory, "routes.sqlite");
    const options = { instanceId: randomUUID(), appsDomain: "sites.example.net" };
    const initial = { epoch: randomUUID(), token: randomBytes(32).toString("hex") };
    initializeRouterState(file, options, initial);
    const store = openRouterState(file, options);
    const credentials = { ...initial, instanceId: options.instanceId };
    return {
        store,
        options,
        credentials,
        headers: {
            authorization: `Bearer ${initial.token}`,
            "x-launchpad-instance": options.instanceId,
            "x-launchpad-epoch": initial.epoch,
            "content-type": "application/json",
        },
        cleanup: () => {
            store.close();
            rmSync(directory, { recursive: true, force: true });
        },
    };
}
