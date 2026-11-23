import { expect, it } from "bun:test";
import { fixtureDeploymentGone, readInventory } from "./inventory";

const row = "11111111-2222-4333-8444-555555555555 lp-123456abcd deleted";
const [deployment] = readInventory(row, []);
const empty = { out: "", err: "", code: 0 };
const missing = { ...empty, err: " !     App lp-123456abcd does not exist", code: 20 };

it("refuses malformed or disappearing database inventory", () => {
    expect(() => readInventory(row.replace("lp-", "prod-"), [])).toThrow();
    expect(() => readInventory("", [deployment!])).toThrow();
    expect(() => readInventory(row.replace("123456abcd", "abcdef1234"), [deployment!])).toThrow();
});

it("requires positive absence and never equates a command failure to cleanup", () => {
    expect(fixtureDeploymentGone(deployment!, missing, empty, empty)).toBe(true);
    expect(
        fixtureDeploymentGone(deployment!, { ...missing, err: "Permission denied" }, empty, empty),
    ).toBe(false);
    expect(fixtureDeploymentGone(deployment!, missing, { ...empty, code: 1 }, empty)).toBe(false);
    expect(fixtureDeploymentGone(deployment!, missing, empty, { ...empty, out: "id" })).toBe(false);
    expect(fixtureDeploymentGone({ ...deployment!, state: "active" }, missing, empty, empty)).toBe(
        false,
    );
});
