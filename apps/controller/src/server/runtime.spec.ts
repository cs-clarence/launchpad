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
            ).toThrow(/registrable domain/);
        }
    });

    it("tells registrable domains apart by the public suffix list", () => {
        const on = { LAUNCHPAD_DEPLOYMENTS: "on" };
        // co.uk is a public suffix: these are two different sites.
        expect(
            previewSettings(
                { ...on, LAUNCHPAD_PREVIEW_DOMAIN: "previews.other.co.uk" },
                "https://launchpad.example.co.uk",
            ).enabled,
        ).toBe(true);
        expect(() =>
            previewSettings(
                { ...on, LAUNCHPAD_PREVIEW_DOMAIN: "previews.example.co.uk" },
                "https://launchpad.example.co.uk",
            ),
        ).toThrow(/registrable/);
        // A controller on an address or localhost has no registrable domain to share.
        expect(
            previewSettings(
                { ...on, LAUNCHPAD_PREVIEW_DOMAIN: "previews.example.net" },
                "http://127.0.0.1:3000",
            ).enabled,
        ).toBe(true);
    });

    it("refuses a preview domain that is not a plain domain name", () => {
        const on = { LAUNCHPAD_DEPLOYMENTS: "on" };
        for (const bad of [
            "https://previews.example.net",
            "previews.example.net/path",
            "previews.example.net:8080",
            "-bad.example.net",
            "localhost",
            "1.2.3.4",
        ]) {
            expect(
                () => previewSettings({ ...on, LAUNCHPAD_PREVIEW_DOMAIN: bad }, ORIGIN),
                bad,
            ).toThrow(/plain lowercase domain/);
        }
        // Off: nothing is read.
        expect(previewSettings({ LAUNCHPAD_PREVIEW_DOMAIN: "https://nope" }, ORIGIN).enabled).toBe(
            false,
        );
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
