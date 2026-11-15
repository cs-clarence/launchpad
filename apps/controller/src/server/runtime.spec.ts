import { describe, expect, it } from "vitest";
import { previewSettings } from "./runtime";

const ORIGIN = "https://launchpad.example.com";

describe("preview settings", () => {
    it("are off unless explicitly on, and read nothing else while off", () => {
        expect(previewSettings({}, ORIGIN).enabled).toBe(false);
        expect(previewSettings({ LAUNCHPAD_DEPLOYMENTS: "off" }, ORIGIN).enabled).toBe(false);
        expect(previewSettings({ LAUNCHPAD_MAX_PREVIEWS: "nonsense" }, ORIGIN).enabled).toBe(false);
        expect(() => previewSettings({ LAUNCHPAD_DEPLOYMENTS: "yes" }, ORIGIN)).toThrow();
    });

    it("need a preview domain of their own once on", () => {
        const on = { LAUNCHPAD_DEPLOYMENTS: "on" };
        expect(() => previewSettings(on, ORIGIN)).toThrow(/LAUNCHPAD_PREVIEW_DOMAIN/);
        expect(
            previewSettings({ ...on, LAUNCHPAD_PREVIEW_DOMAIN: "Previews.Example.NET" }, ORIGIN),
        ).toMatchObject({ enabled: true, previewDomain: "previews.example.net" });
        // The controller's own host, or a parent or child of it, is not a separate domain.
        for (const bad of ["launchpad.example.com", "example.com", "app.launchpad.example.com"]) {
            expect(
                () => previewSettings({ ...on, LAUNCHPAD_PREVIEW_DOMAIN: bad }, ORIGIN),
                bad,
            ).toThrow(/different domain/);
        }
    });

    it("checks the preview limit", () => {
        const on = {
            LAUNCHPAD_DEPLOYMENTS: "on",
            LAUNCHPAD_PREVIEW_DOMAIN: "previews.example.net",
        };
        expect(previewSettings({ ...on, LAUNCHPAD_MAX_PREVIEWS: "25" }, ORIGIN).maxPreviews).toBe(
            25,
        );
        for (const bad of ["0", "-1", "1.5", "many"]) {
            expect(() => previewSettings({ ...on, LAUNCHPAD_MAX_PREVIEWS: bad }, ORIGIN)).toThrow();
        }
    });
});
