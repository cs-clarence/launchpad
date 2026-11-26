import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createContext } from "../packages/client-core/src/index";
import { PROFILE, realDeps } from "./local-deploy";

// The real profile functions, against a temporary configuration directory only.
const CONTROLLER = "http://127.0.0.1:32180";
let dir: string;
let env: Record<string, string>;
const ctx = () => createContext(env, { fetch });
const deps = () => realDeps("/repo", "0", new AbortController().signal, env);
const entry = (controller: string) => ({
    controller,
    apiKey: "lp_x",
    organizationId: "00000000-0000-4000-8000-000000000000",
    savedAt: new Date().toISOString(),
});
const arrange = async (current: string | null, others: string[] = []) => {
    await ctx().store.update((config) => {
        config.profiles[PROFILE] = entry(CONTROLLER);
        for (const name of others) config.profiles[name] = entry("http://127.0.0.1:3000");
        config.currentProfile = current;
    });
};
const load = () => ctx().store.load();

beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "local-deploy-profile-"));
    env = { HOME: dir, LAUNCHPAD_CONFIG_DIR: path.join(dir, "cfg") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the real profile functions", () => {
    it("reads the current profile, or null when none", async () => {
        expect(await deps().currentProfile()).toBeNull();
        await arrange("mine", ["mine"]);
        expect(await deps().currentProfile()).toBe("mine");
    });

    it("resets the current profile to none only when asked and it is this profile", async () => {
        await arrange(PROFILE, ["mine"]);
        await deps().removeProfile(CONTROLLER, true);
        const config = await load();
        expect(config.currentProfile).toBeNull();
        expect(Object.keys(config.profiles)).toEqual(["mine"]);
    });

    it("leaves another current profile alone, even when asked", async () => {
        await arrange("mine", ["mine"]);
        await deps().removeProfile(CONTROLLER, true);
        const config = await load();
        expect(config.currentProfile).toBe("mine");
        expect(config.profiles[PROFILE]).toBeUndefined();
    });

    it("selects a remaining profile when the user made it current themselves", async () => {
        await arrange(PROFILE, ["mine"]);
        await deps().removeProfile(CONTROLLER, false);
        expect((await load()).currentProfile).toBe("mine");
    });

    it("never leaves a dangling current profile, even with none remaining", async () => {
        await arrange(PROFILE);
        await deps().removeProfile(CONTROLLER, false);
        const config = await load();
        expect(config.currentProfile).toBeNull();
        expect(config.profiles[PROFILE]).toBeUndefined();
    });

    it("keeps a profile that names another controller", async () => {
        await arrange(PROFILE);
        await deps().removeProfile("http://127.0.0.1:9999", true);
        expect((await load()).profiles[PROFILE]).toBeDefined();
    });
});
