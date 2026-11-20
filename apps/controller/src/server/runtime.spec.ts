import { afterEach, describe, expect, it } from "vitest";
import { getRuntime } from "./runtime";

const saved = { ...process.env };
afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
});

describe("controller startup configuration", () => {
    it("refuses a removed preview setting before reading anything else", () => {
        process.env.LAUNCHPAD_PREVIEW_DOMAIN = "previews.example.com";
        expect(() => getRuntime()).toThrow("LAUNCHPAD_PREVIEW_DOMAIN is no longer used");
    });

    it("refuses a removed lifecycle setting", () => {
        process.env.LAUNCHPAD_LIFECYCLE = "on";
        expect(() => getRuntime()).toThrow("LAUNCHPAD_LIFECYCLE is no longer used");
    });
});
