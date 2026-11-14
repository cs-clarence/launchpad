import { describe, expect, it } from "vitest";
import { api } from "./api";

describe("controller HTTP adapter", () => {
    it("delegates the scaffold health response to the service", async () => {
        const response = await api.fetch(new Request("http://localhost/api/health"));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            name: "launchpad",
            phase: "bootstrap",
        });
    });

    it("has no deployment endpoint", async () => {
        const response = await api.fetch(
            new Request("http://localhost/api/deployments", { method: "POST" }),
        );
        expect(response.status).toBe(404);
    });
});
